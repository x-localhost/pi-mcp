import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanTemplate, hasForbiddenBytes, isValidHeaderName } from '../src/headers.mjs';

const ROUTE = '/v1/chat/completions';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_HEADERS = 16 * 1024;
const MAX_ACTIVE = 8;
const BODY_TIMEOUT_MS = 15_000;
const UPSTREAM_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CONFIG_KEYS = new Set(['upstreamUrl', 'upstreamAddress', 'model', 'caFile', 'headers']);
const RESERVED_HEADERS = /^(?:host|content-length|content-type|connection|transfer-encoding|upgrade|proxy-.*|x-forwarded-.*|forwarded|via|te|trailer|keep-alive|accept-encoding|expect|http2-settings)$/i;
const UNSAFE_ENV_REF = /^(?:NODE_|LD_|DYLD_|GIT_CONFIG(?:_|$)|NPM_|PI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|HOME$|PATH$|SHELL$|BASH_ENV$|ENV$|SSH_AUTH_SOCK$|OPENSSL_CONF$|SSL_CERT_FILE$|SSL_CERT_DIR$)/i;
const HEADER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const MODEL_ID = /^[^\x00-\x1f\x7f]{1,120}$/;
const invalidConfig = () => new Error('Invalid gateway configuration');
const invalidChat = () => new Error('Invalid chat request');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

function privateAddress(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function resolveHeaders(headers, env) {
  if (!object(headers)) throw invalidConfig();
  const resolved = {};
  const seen = new Set();
  let total = 0;
  for (const [name, template] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!isValidHeaderName(name) || RESERVED_HEADERS.test(name) || seen.has(lower) || typeof template !== 'string' || !template || template.startsWith('!') || hasForbiddenBytes(template)) throw invalidConfig();
    seen.add(lower);
    const parts = scanTemplate(template);
    if (/\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/.test(template) || /\$\(|`/.test(template)) throw invalidConfig();
    if (/^(?:authorization|.*(?:api[-_]?key|token|secret|credential).*)$/i.test(name) && !parts.some(part => part.type === 'ref')) throw invalidConfig();
    let value = '';
    for (const part of parts) {
      if (part.type === 'literal') value += part.text;
      else {
        if (UNSAFE_ENV_REF.test(part.name)) throw invalidConfig();
        const secret = env[part.name];
        if (typeof secret !== 'string' || !secret || hasForbiddenBytes(secret)) throw invalidConfig();
        value += secret;
      }
    }
    if (!value || value.length > 8192 || hasForbiddenBytes(value)) throw invalidConfig();
    total += name.length + value.length;
    if (total > MAX_HEADERS) throw invalidConfig();
    resolved[name] = value;
  }
  return resolved;
}

export function validateGatewayConfig(raw, { env = process.env } = {}) {
  if (!object(raw) || Object.keys(raw).some(key => !CONFIG_KEYS.has(key)) || !privateAddress(raw.upstreamAddress) || typeof raw.upstreamUrl !== 'string' || typeof raw.model !== 'string' || !MODEL_ID.test(raw.model) || raw.model.trim() !== raw.model) throw invalidConfig();
  // Match the raw URL too: URL normalization must not turn encoded or dot-segment paths into the approved route.
  const match = /^https:\/\/([^/?#]+)(\/(?:[A-Za-z0-9._~-]+\/)*v1\/chat\/completions)$/.exec(raw.upstreamUrl);
  if (!match || match[1].includes('@') || match[1].includes('*')) throw invalidConfig();
  const path = match[2];
  if (path.slice(1).split('/').some(segment => segment === '.' || segment === '..')) throw invalidConfig();
  let url;
  try { url = new URL(raw.upstreamUrl); } catch { throw invalidConfig(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== path || !HEADER_NAME.test(url.hostname) || !url.hostname.includes('.') || /\.{2}/.test(url.hostname) || /^[0-9.]+$/.test(url.hostname) || url.hostname.endsWith('.')) throw invalidConfig();
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalidConfig();
  let ca;
  if (raw.caFile !== undefined) {
    if (typeof raw.caFile !== 'string' || !isAbsolute(raw.caFile)) throw invalidConfig();
    try {
      const stat = fs.lstatSync(raw.caFile);
      if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw invalidConfig();
      ca = fs.readFileSync(raw.caFile);
    } catch { throw invalidConfig(); }
  }
  return Object.freeze({ address: raw.upstreamAddress, hostname: url.hostname, port, path, model: raw.model, ca, headers: Object.freeze(resolveHeaders(raw.headers ?? {}, env)) });
}

function validateContent(content) {
  if (typeof content === 'string') return;
  if (!Array.isArray(content) || content.length < 1 || content.length > 128) throw invalidChat();
  for (const part of content) {
    if (!object(part)) throw invalidChat();
    if (part.type === 'text') {
      if (!exact(part, ['type', 'text']) || typeof part.text !== 'string') throw invalidChat();
    } else if (part.type === 'image_url') {
      if (!exact(part, ['type', 'image_url']) || !exact(part.image_url, ['url', 'detail']) || typeof part.image_url.url !== 'string' || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(part.image_url.url) || (part.image_url.detail !== undefined && !['auto', 'low', 'high'].includes(part.image_url.detail))) throw invalidChat();
    } else throw invalidChat();
  }
}

function validateToolCalls(calls) {
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 128) throw invalidChat();
  for (const call of calls) {
    if (!exact(call, ['id', 'type', 'function']) || call.type !== 'function' || typeof call.id !== 'string' || !call.id || !exact(call.function, ['name', 'arguments']) || typeof call.function.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(call.function.name) || typeof call.function.arguments !== 'string') throw invalidChat();
  }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 128) throw invalidChat();
  for (const message of messages) {
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw invalidChat();
    if (message.role === 'tool') {
      if (!exact(message, ['role', 'tool_call_id', 'content']) || typeof message.tool_call_id !== 'string' || !message.tool_call_id || typeof message.content !== 'string') throw invalidChat();
    } else if (message.role === 'assistant') {
      if (!exact(message, ['role', 'content', 'name', 'tool_calls']) || (message.content === undefined && message.tool_calls === undefined) || (message.name !== undefined && typeof message.name !== 'string')) throw invalidChat();
      if (message.content !== null && message.content !== undefined) validateContent(message.content);
      if (message.tool_calls !== undefined) validateToolCalls(message.tool_calls);
    } else {
      if (!exact(message, ['role', 'content', 'name']) || message.content === undefined || (message.name !== undefined && typeof message.name !== 'string')) throw invalidChat();
      validateContent(message.content);
    }
  }
}

function validateSchemaRefs(value, depth = 0) {
  if (depth > 32) throw invalidChat();
  if (Array.isArray(value)) { for (const item of value) validateSchemaRefs(item, depth + 1); return; }
  if (!object(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#/'))) throw invalidChat();
    validateSchemaRefs(child, depth + 1);
  }
}

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length > 128) throw invalidChat();
  for (const tool of tools) {
    if (!exact(tool, ['type', 'function']) || tool.type !== 'function' || !exact(tool.function, ['name', 'description', 'parameters', 'strict']) || typeof tool.function.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.function.name) || (tool.function.description !== undefined && typeof tool.function.description !== 'string') || (tool.function.parameters !== undefined && !object(tool.function.parameters)) || (tool.function.strict !== undefined && typeof tool.function.strict !== 'boolean')) throw invalidChat();
    if (tool.function.parameters !== undefined) validateSchemaRefs(tool.function.parameters);
  }
}

const CHAT_KEYS = ['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'n', 'seed', 'frequency_penalty', 'presence_penalty', 'response_format', 'user', 'reasoning_effort', 'store'];
export function validateChatBody(raw, model) {
  if (!exact(raw, CHAT_KEYS) || raw.model !== model) throw invalidChat();
  if (raw.store !== undefined && raw.store !== false) throw invalidChat();
  validateMessages(raw.messages);
  if (raw.tools !== undefined) validateTools(raw.tools);
  if (raw.stream !== undefined && typeof raw.stream !== 'boolean') throw invalidChat();
  if (raw.stream_options !== undefined && (!exact(raw.stream_options, ['include_usage']) || typeof raw.stream_options.include_usage !== 'boolean' || raw.stream !== true)) throw invalidChat();
  if (raw.tool_choice !== undefined) {
    if (typeof raw.tool_choice === 'string') { if (!['none', 'auto', 'required'].includes(raw.tool_choice)) throw invalidChat(); }
    else if (!exact(raw.tool_choice, ['type', 'function']) || raw.tool_choice.type !== 'function' || !exact(raw.tool_choice.function, ['name']) || typeof raw.tool_choice.function.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.tool_choice.function.name)) throw invalidChat();
  }
  for (const key of ['parallel_tool_calls']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw invalidChat();
  for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) throw invalidChat();
  for (const key of ['max_tokens', 'max_completion_tokens', 'n']) if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || raw[key] < 1)) throw invalidChat();
  if (raw.seed !== undefined && !Number.isSafeInteger(raw.seed)) throw invalidChat();
  if (raw.stop !== undefined && !(typeof raw.stop === 'string' || (Array.isArray(raw.stop) && raw.stop.length <= 4 && raw.stop.every(item => typeof item === 'string')))) throw invalidChat();
  if (raw.user !== undefined && (typeof raw.user !== 'string' || raw.user.length > 256)) throw invalidChat();
  if (raw.reasoning_effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high'].includes(raw.reasoning_effort)) throw invalidChat();
  if (raw.response_format !== undefined) {
    if (!exact(raw.response_format, ['type', 'json_schema']) || !['text', 'json_object', 'json_schema'].includes(raw.response_format.type)) throw invalidChat();
    if (raw.response_format.type === 'json_schema') {
      const schema = raw.response_format.json_schema;
      if (!exact(schema, ['name', 'description', 'schema', 'strict']) || typeof schema.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(schema.name) || !object(schema.schema) || (schema.description !== undefined && typeof schema.description !== 'string') || (schema.strict !== undefined && typeof schema.strict !== 'boolean')) throw invalidChat();
      validateSchemaRefs(schema.schema);
    } else if (raw.response_format.json_schema !== undefined) throw invalidChat();
  }
  // A fresh object and JSON serialization prevent unvalidated bytes from reaching the upstream.
  return structuredClone(raw);
}

function respond(res, status, text) {
  if (res.headersSent || res.destroyed) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function handleChat(req, res, config, requestImpl, release) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) { respond(res, 415, 'Unsupported media type\n'); return; }
  const declared = Number(req.headers['content-length']);
  if (req.headers['content-length'] !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY)) { respond(res, 413, 'Request too large\n'); return; }
  let bytes = 0;
  const chunks = [];
  const bodyTimer = setTimeout(() => { respond(res, 408, 'Request timeout\n'); req.destroy(); }, BODY_TIMEOUT_MS);
  bodyTimer.unref();
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_BODY) { clearTimeout(bodyTimer); respond(res, 413, 'Request too large\n'); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    clearTimeout(bodyTimer);
    if (res.writableEnded || res.destroyed) return;
    let sanitized;
    try { sanitized = validateChatBody(JSON.parse(Buffer.concat(chunks).toString('utf8')), config.model); }
    catch { respond(res, 400, 'Invalid chat request\n'); return; }
    const data = Buffer.from(JSON.stringify(sanitized));
    const headers = { Host: `${config.hostname}${config.port === 443 ? '' : `:${config.port}`}`, 'Content-Type': 'application/json', 'Content-Length': String(data.length), 'Accept-Encoding': 'identity', ...config.headers };
    const options = { protocol: 'https:', hostname: config.address, port: config.port, method: 'POST', path: config.path, servername: config.hostname, rejectUnauthorized: true, headers, agent: false };
    if (config.ca) options.ca = config.ca;
    let upstream;
    try { upstream = requestImpl(options, reply => {
      if (reply.statusCode < 200 || reply.statusCode >= 300 || (reply.headers['content-encoding'] && reply.headers['content-encoding'] !== 'identity')) {
        reply.destroy(); respond(res, 502, 'Upstream unavailable\n'); return;
      }
      const type = reply.headers['content-type'];
      if (typeof type !== 'string' || !/^(?:application\/json|text\/event-stream)(?:\s*;\s*charset=utf-8)?$/i.test(type)) { reply.destroy(); respond(res, 502, 'Upstream unavailable\n'); return; }
      res.writeHead(reply.statusCode, { 'Content-Type': type });
      reply.on('error', () => res.destroy());
      reply.pipe(res);
    }); } catch { respond(res, 502, 'Upstream unavailable\n'); return; }
    const timeout = setTimeout(() => upstream.destroy(new Error('timeout')), UPSTREAM_TIMEOUT_MS);
    timeout.unref();
    let connectTimer = setTimeout(() => upstream.destroy(new Error('timeout')), CONNECT_TIMEOUT_MS);
    connectTimer.unref();
    upstream.on('socket', socket => {
      if (socket.encrypted) socket.once('secureConnect', () => { clearTimeout(connectTimer); connectTimer = null; });
      else if (!socket.connecting) { clearTimeout(connectTimer); connectTimer = null; }
      else socket.once('connect', () => { clearTimeout(connectTimer); connectTimer = null; });
    });
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => respond(res, 502, 'Upstream unavailable\n'));
    res.once('close', () => { clearTimeout(timeout); if (connectTimer) clearTimeout(connectTimer); upstream.destroy(); });
    upstream.end(data);
  });
  req.on('error', () => { clearTimeout(bodyTimer); release(); });
}

export async function startGateway({ config, socketPath, requestImpl = https.request }) {
  if (!config || !privateAddress(config.address) || typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new Error('Gateway startup failed');
  let active = 0;
  const sockets = new Set();
  const server = http.createServer({ maxHeaderSize: MAX_HEADERS }, (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') { respond(res, 200, 'ok\n'); return; }
    if (req.method !== 'POST' || req.url !== ROUTE || req.headers.upgrade) { respond(res, 404, 'Not found\n'); return; }
    if (active >= MAX_ACTIVE) { respond(res, 503, 'Busy\n'); return; }
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once('close', release);
    res.once('finish', release);
    handleChat(req, res, config, requestImpl, release);
  });
  server.maxHeadersCount = 64;
  server.maxConnections = 32;
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 2_000;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); });
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('checkContinue', (_req, res) => respond(res, 417, 'Expectation failed\n'));
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  if (fs.existsSync(socketPath)) {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Gateway startup failed');
    // An existing live listener must never be displaced.
    const occupied = await new Promise(resolve => {
      const probe = http.request({ socketPath, path: '/healthz', timeout: 500 }, reply => { reply.resume(); resolve(true); });
      probe.on('error', error => resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT' ? true : false));
      probe.on('timeout', () => { probe.destroy(); resolve(true); });
      probe.end();
    });
    if (occupied) throw new Error('Gateway startup failed');
    fs.unlinkSync(socketPath);
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  fs.chmodSync(socketPath, 0o600);
  const inode = fs.lstatSync(socketPath).ino;
  return { socketPath, close: async () => {
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(() => resolve()));
    try { if (fs.lstatSync(socketPath).ino === inode) fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } };
}

async function main() {
  if (process.argv.length !== 4) throw new Error('Gateway startup failed');
  const [configPath, socketPath] = process.argv.slice(2);
  if (!isAbsolute(configPath) || !isAbsolute(socketPath)) throw new Error('Gateway startup failed');
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error('Gateway startup failed');
  const config = validateGatewayConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  await startGateway({ config, socketPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Gateway startup failed\n'); process.exitCode = 1; });
}
