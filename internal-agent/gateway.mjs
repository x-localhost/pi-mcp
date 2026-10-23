import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { scanTemplate, hasForbiddenBytes, isValidHeaderName } from '../src/headers.mjs';
import { validateMcpToolDeclarations, validateToolArguments, pinnedMcpDiscovery } from '../src/approved-mcp.mjs';

const ROUTE = '/v1/chat/completions';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_HEADERS = 16 * 1024;
const MAX_ACTIVE = 8;
const BODY_TIMEOUT_MS = 15_000;
const UPSTREAM_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CONFIG_KEYS = new Set(['upstreamUrl', 'upstreamAddress', 'model', 'caFile', 'headers', 'limits', 'mcpServers']);
const RESERVED_HEADERS = /^(?:host|content-length|content-type|connection|transfer-encoding|upgrade|proxy-.*|x-forwarded-.*|forwarded|via|te|trailer|keep-alive|accept-encoding|accept|expect|http2-settings|mcp-.*)$/i;
const UNSAFE_ENV_REF = /^(?:NODE_|LD_|DYLD_|GIT_CONFIG(?:_|$)|NPM_|PI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|HOME$|PATH$|SHELL$|BASH_ENV$|ENV$|SSH_AUTH_SOCK$|OPENSSL_CONF$|SSL_CERT_FILE$|SSL_CERT_DIR$)/i;
const HEADER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const MODEL_ID = /^[^\x00-\x1f\x7f]{1,120}$/;
const invalidConfig = () => new Error('Invalid gateway configuration');
const invalidChat = () => new Error('Invalid chat request');
const invalidMcp = () => new Error('Invalid MCP request');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

function privateAddress(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function boundedLimits(raw) {
  if (raw === undefined) raw = {};
  if (!exact(raw, ['maxOutputTokens', 'maxN', 'requestsPerMinute'])) throw invalidConfig();
  const limits = { maxOutputTokens: raw.maxOutputTokens ?? 4096, maxN: raw.maxN ?? 1, requestsPerMinute: raw.requestsPerMinute ?? 60 };
  for (const [key, low, high] of [['maxOutputTokens', 1, 16384], ['maxN', 1, 4], ['requestsPerMinute', 1, 600]]) {
    if (!Number.isInteger(limits[key]) || limits[key] < low || limits[key] > high) throw invalidConfig();
  }
  return Object.freeze(limits);
}

function readCa(file) {
  if (file === undefined) return undefined;
  if (typeof file !== 'string' || !isAbsolute(file)) throw invalidConfig();
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw invalidConfig();
    return fs.readFileSync(file);
  } catch { throw invalidConfig(); }
}

function validateMcpServer(raw, env) {
  if (!exact(raw, ['id', 'upstreamUrl', 'upstreamAddress', 'caFile', 'headers', 'backendAttested', 'tools']) || typeof raw.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(raw.id) || raw.backendAttested !== true || !privateAddress(raw.upstreamAddress) || typeof raw.upstreamUrl !== 'string') throw invalidConfig();
  const match = /^https:\/\/([^/?#]+)(\/[A-Za-z0-9._~/-]+)$/.exec(raw.upstreamUrl);
  if (!match || match[1].includes('@') || match[1].includes('*') || match[2].includes('//') || match[2].slice(1).split('/').some(part => part === '.' || part === '..')) throw invalidConfig();
  let url;
  try { url = new URL(raw.upstreamUrl); } catch { throw invalidConfig(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== match[2] || !HEADER_NAME.test(url.hostname) || !url.hostname.includes('.') || /\.{2}/.test(url.hostname) || /^[0-9.]+$/.test(url.hostname) || url.hostname.endsWith('.')) throw invalidConfig();
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalidConfig();
  let tools;
  try { tools = validateMcpToolDeclarations(raw.tools); } catch { throw invalidConfig(); }
  return Object.freeze({ id: raw.id, address: raw.upstreamAddress, hostname: url.hostname, port, path: match[2], ca: readCa(raw.caFile), headers: Object.freeze(resolveHeaders(raw.headers ?? {}, env)), tools, backendAttested: true });
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
  const ca = readCa(raw.caFile);
  if (raw.mcpServers !== undefined && (!Array.isArray(raw.mcpServers) || raw.mcpServers.length > 4)) throw invalidConfig();
  const mcpServers = (raw.mcpServers ?? []).map(server => validateMcpServer(server, env));
  if (new Set(mcpServers.map(server => server.id)).size !== mcpServers.length) throw invalidConfig();
  return Object.freeze({ address: raw.upstreamAddress, hostname: url.hostname, port, path, model: raw.model, ca, headers: Object.freeze(resolveHeaders(raw.headers ?? {}, env)), limits: boundedLimits(raw.limits), mcpServers });
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

export function enforceChatLimits(body, limits) {
  if (!object(body) || !limits || !Number.isInteger(limits.maxOutputTokens) || !Number.isInteger(limits.maxN)) throw invalidChat();
  if (body.n !== undefined && body.n > limits.maxN) throw invalidChat();
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw invalidChat();
  const requested = body.max_completion_tokens ?? body.max_tokens;
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > limits.maxOutputTokens)) throw invalidChat();
  const forwarded = structuredClone(body);
  if (requested === undefined) forwarded.max_completion_tokens = limits.maxOutputTokens;
  return forwarded;
}

const MCP_VERSION = '2025-11-25';
export function validateMcpRpc(raw, server) {
  if (!exact(raw, ['jsonrpc', 'id', 'method', 'params']) || raw.jsonrpc !== '2.0' || typeof raw.method !== 'string' || !server || !Array.isArray(server.tools)) throw invalidMcp();
  const notification = raw.method === 'notifications/initialized';
  if (notification) {
    if (raw.id !== undefined || (raw.params !== undefined && (!object(raw.params) || Object.keys(raw.params).length))) throw invalidMcp();
    return { jsonrpc: '2.0', method: raw.method };
  }
  if ((typeof raw.id !== 'string' && !Number.isSafeInteger(raw.id)) || (typeof raw.id === 'string' && (!raw.id || raw.id.length > 64))) throw invalidMcp();
  const base = { jsonrpc: '2.0', id: raw.id, method: raw.method };
  if (raw.method === 'initialize') {
    if (!exact(raw.params, ['protocolVersion', 'capabilities', 'clientInfo']) || raw.params.protocolVersion !== MCP_VERSION || !object(raw.params.capabilities) || Object.keys(raw.params.capabilities).length || !exact(raw.params.clientInfo, ['name', 'version']) || typeof raw.params.clientInfo.name !== 'string' || typeof raw.params.clientInfo.version !== 'string' || raw.params.clientInfo.name.length > 64 || raw.params.clientInfo.version.length > 32) throw invalidMcp();
    return { ...base, params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'pi-mcp-approved', version: '1.0.0' } } };
  }
  if (raw.method === 'ping' || raw.method === 'tools/list') {
    if (raw.params !== undefined && (!object(raw.params) || Object.keys(raw.params).length)) throw invalidMcp();
    return { ...base, params: {} };
  }
  if (raw.method === 'tools/call') {
    if (!exact(raw.params, ['name', 'arguments']) || typeof raw.params.name !== 'string' || !object(raw.params.arguments)) throw invalidMcp();
    const tool = server.tools.find(item => item.name === raw.params.name);
    if (!tool || !validateToolArguments(tool.inputSchema, raw.params.arguments)) throw invalidMcp();
    return { ...base, params: { name: tool.name, arguments: structuredClone(raw.params.arguments) } };
  }
  throw invalidMcp();
}

function respond(res, status, text, category = 'protocol') {
  if (res.__gatewayCategory === undefined || res.__gatewayCategory === 'ok') res.__gatewayCategory = category;
  if (res.headersSent || res.destroyed) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Gateway-Category': category });
  res.end(text);
}

function upstreamCategory(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 300 && status < 400) return 'protocol';
  return 'upstream';
}

function errorCategory(error) {
  if (error?.message === 'timeout') return 'timeout';
  if (/^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT)/.test(error?.code ?? '')) return 'tls';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ENOTFOUND'].includes(error?.code)) return 'connect';
  if (error?.code === 'ETIMEDOUT') return 'timeout';
  return 'upstream';
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
    try { sanitized = enforceChatLimits(validateChatBody(JSON.parse(Buffer.concat(chunks).toString('utf8')), config.model), config.limits); }
    catch { respond(res, 400, 'Invalid chat request\n'); return; }
    const data = Buffer.from(JSON.stringify(sanitized));
    const headers = { Host: `${config.hostname}${config.port === 443 ? '' : `:${config.port}`}`, 'Content-Type': 'application/json', 'Content-Length': String(data.length), 'Accept-Encoding': 'identity', ...config.headers };
    const options = { protocol: 'https:', hostname: config.address, port: config.port, method: 'POST', path: config.path, servername: config.hostname, rejectUnauthorized: true, headers, agent: false };
    if (config.ca) options.ca = config.ca;
    let upstream;
    try { upstream = requestImpl(options, reply => {
      if (reply.statusCode < 200 || reply.statusCode >= 300 || (reply.headers['content-encoding'] && reply.headers['content-encoding'] !== 'identity')) {
        reply.destroy(); respond(res, 502, 'Upstream unavailable\n', upstreamCategory(reply.statusCode)); return;
      }
      const type = reply.headers['content-type'];
      if (typeof type !== 'string' || !/^(?:application\/json|text\/event-stream)(?:\s*;\s*charset=utf-8)?$/i.test(type)) { reply.destroy(); respond(res, 502, 'Upstream unavailable\n', 'protocol'); return; }
      res.__gatewayCategory = 'ok';
      res.writeHead(reply.statusCode, { 'Content-Type': type });
      reply.on('error', () => respond(res, 502, 'Upstream unavailable\n', 'upstream'));
      reply.on('aborted', () => respond(res, 502, 'Upstream unavailable\n', 'protocol'));
      reply.on('end', () => { if (reply.complete === false) respond(res, 502, 'Upstream unavailable\n', 'protocol'); });
      reply.on('close', () => { if (reply.complete === false) respond(res, 502, 'Upstream unavailable\n', 'protocol'); });
      reply.pipe(res);
    }); } catch { respond(res, 502, 'Upstream unavailable\n', 'upstream'); return; }
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
    upstream.on('error', error => respond(res, 502, 'Upstream unavailable\n', errorCategory(error)));
    res.once('close', () => { clearTimeout(timeout); if (connectTimer) clearTimeout(connectTimer); upstream.destroy(); });
    upstream.end(data);
  });
  req.on('error', () => { clearTimeout(bodyTimer); release(); });
}

function sanitizeMcpReply(reply, request, server) {
  if (!exact(reply, ['jsonrpc', 'id', 'result', 'error']) || reply.jsonrpc !== '2.0' || reply.id !== request.id || !object(reply.result) || reply.error !== undefined) throw invalidMcp();
  let result;
  if (request.method === 'initialize') {
    if (reply.result.protocolVersion !== MCP_VERSION || !object(reply.result.capabilities) || !object(reply.result.serverInfo) || typeof reply.result.serverInfo.name !== 'string' || typeof reply.result.serverInfo.version !== 'string') throw invalidMcp();
    result = { protocolVersion: MCP_VERSION, capabilities: { tools: {} }, serverInfo: { name: reply.result.serverInfo.name.slice(0, 128), version: reply.result.serverInfo.version.slice(0, 64) } };
  } else if (request.method === 'tools/list') {
    if (reply.result.nextCursor !== undefined || !pinnedMcpDiscovery(server.tools, reply.result.tools)) throw invalidMcp();
    result = { tools: server.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
  } else if (request.method === 'tools/call') {
    if (!Array.isArray(reply.result.content) || reply.result.content.length > 16 || Buffer.byteLength(JSON.stringify(reply.result)) > 32 * 1024 || (reply.result.isError !== undefined && typeof reply.result.isError !== 'boolean')) throw invalidMcp();
    const content = reply.result.content.map(part => {
      if (!object(part) || part.type !== 'text' || typeof part.text !== 'string' || Buffer.byteLength(part.text) > 32 * 1024) throw invalidMcp();
      return { type: 'text', text: part.text };
    });
    result = { content, isError: reply.result.isError === true };
  } else if (request.method === 'ping') result = {};
  else throw invalidMcp();
  return { jsonrpc: '2.0', id: request.id, result };
}

function handleMcp(req, res, server, requestImpl) {
  if (req.headers['mcp-session-id'] || req.headers['last-event-id'] || req.headers.upgrade || (req.headers.accept && req.headers.accept.includes('text/event-stream')) || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) { respond(res, 400, 'Invalid MCP request\n'); return; }
  const declared = Number(req.headers['content-length']);
  if (req.headers['content-length'] !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > 64 * 1024)) { respond(res, 413, 'Request too large\n'); return; }
  let bytes = 0; const chunks = [];
  const bodyTimer = setTimeout(() => { respond(res, 408, 'Request timeout\n', 'timeout'); req.destroy(); }, BODY_TIMEOUT_MS);
  bodyTimer.unref();
  req.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) { clearTimeout(bodyTimer); respond(res, 413, 'Request too large\n'); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => {
    clearTimeout(bodyTimer);
    if (res.destroyed || res.writableEnded) return;
    let message;
    try { message = validateMcpRpc(JSON.parse(Buffer.concat(chunks).toString('utf8')), server); }
    catch { respond(res, 400, 'Invalid MCP request\n'); return; }
    const data = Buffer.from(JSON.stringify(message));
    const options = { protocol: 'https:', hostname: server.address, port: server.port, method: 'POST', path: server.path, servername: server.hostname, rejectUnauthorized: true, agent: false,
      headers: { Host: `${server.hostname}${server.port === 443 ? '' : `:${server.port}`}`, 'Content-Type': 'application/json', 'Content-Length': String(data.length), Accept: 'application/json', 'MCP-Protocol-Version': MCP_VERSION, 'Accept-Encoding': 'identity', ...server.headers } };
    if (server.ca) options.ca = server.ca;
    let peer;
    try { peer = requestImpl(options, reply => {
      if (message.method === 'notifications/initialized' && reply.statusCode === 202 && !reply.headers['mcp-session-id'] && (!reply.headers['content-encoding'] || reply.headers['content-encoding'] === 'identity')) {
        let acknowledgementBytes = 0;
        reply.on('data', chunk => { acknowledgementBytes += chunk.length; if (acknowledgementBytes > 64 * 1024) { reply.destroy(); respond(res, 502, 'MCP upstream unavailable\n', 'protocol'); } });
        reply.on('end', () => {
          if (res.writableEnded || res.destroyed) return;
          if (reply.complete === false || acknowledgementBytes !== 0) respond(res, 502, 'MCP upstream unavailable\n', 'protocol');
          else { res.__gatewayCategory = 'ok'; res.writeHead(202); res.end(); }
        });
        reply.on('aborted', () => respond(res, 502, 'MCP upstream unavailable\n', 'protocol'));
        reply.on('close', () => { if (reply.complete === false) respond(res, 502, 'MCP upstream unavailable\n', 'protocol'); });
        reply.on('error', () => respond(res, 502, 'MCP upstream unavailable\n', 'protocol'));
        return;
      }
      if (reply.statusCode !== 200) { reply.destroy(); respond(res, 502, 'MCP upstream unavailable\n', upstreamCategory(reply.statusCode)); return; }
      if (reply.headers['mcp-session-id'] || reply.headers['content-encoding'] && reply.headers['content-encoding'] !== 'identity' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers['content-type'] ?? '')) { reply.destroy(); respond(res, 502, 'MCP upstream unavailable\n', 'protocol'); return; }
      let responseBytes = 0; const responseChunks = [];
      reply.on('data', chunk => { responseBytes += chunk.length; if (responseBytes > 64 * 1024) { reply.destroy(); respond(res, 502, 'MCP upstream unavailable\n', 'protocol'); } else responseChunks.push(chunk); });
      reply.on('end', () => {
        if (res.writableEnded || res.destroyed) return;
        if (reply.complete === false) { respond(res, 502, 'MCP upstream unavailable\n', 'protocol'); return; }
        try {
          const sanitized = sanitizeMcpReply(JSON.parse(Buffer.concat(responseChunks).toString('utf8')), message, server);
          res.__gatewayCategory = 'ok'; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(sanitized));
        } catch { respond(res, 502, 'MCP upstream unavailable\n', 'protocol'); }
      });
      reply.on('error', () => respond(res, 502, 'MCP upstream unavailable\n', 'upstream'));
      reply.on('aborted', () => respond(res, 502, 'MCP upstream unavailable\n', 'protocol'));
      reply.on('close', () => { if (reply.complete === false) respond(res, 502, 'MCP upstream unavailable\n', 'protocol'); });
    }); } catch { respond(res, 502, 'MCP upstream unavailable\n', 'upstream'); return; }
    const timer = setTimeout(() => peer.destroy(new Error('timeout')), 15_000);
    timer.unref();
    peer.setTimeout(10_000, () => peer.destroy(new Error('timeout')));
    peer.on('error', error => respond(res, 502, 'MCP upstream unavailable\n', errorCategory(error)));
    res.once('close', () => { clearTimeout(timer); peer.destroy(); });
    peer.end(data);
  });
  req.on('error', () => clearTimeout(bodyTimer));
}

export async function startGateway({ config, socketPath, requestImpl = https.request }) {
  if (!config || !privateAddress(config.address) || typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new Error('Gateway startup failed');
  let active = 0;
  const rateTimes = [];
  const audit = [];
  const auditPath = `${socketPath}.audit.jsonl`;
  const sockets = new Set();
  const server = http.createServer({ maxHeaderSize: MAX_HEADERS }, (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('ok\n'); return; }
    const mcpMatch = typeof req.url === 'string' ? /^\/internal-mcp\/([a-z][a-z0-9_]{0,31})$/.exec(req.url) : null;
    const mcpServer = mcpMatch && config.mcpServers?.find(item => item.id === mcpMatch[1]);
    if (req.method !== 'POST' || !(req.url === ROUTE || mcpServer) || req.headers.upgrade) { respond(res, 404, 'Not found\n'); return; }
    const requestId = randomUUID();
    const start = Date.now();
    res.setHeader('X-Request-Id', requestId);
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const completed = res.writableFinished;
      const category = !completed && res.__gatewayCategory === 'ok' ? 'connect' : res.__gatewayCategory ?? 'protocol';
      audit.push({ requestId, category, status: res.statusCode, completed, aborted: !completed, elapsedMs: Math.min(120_000, Date.now() - start) });
      if (audit.length > 256) audit.shift();
      const tmp = `${auditPath}.${randomUUID()}`;
      try { fs.writeFileSync(tmp, audit.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, auditPath); }
      catch { try { fs.unlinkSync(tmp); } catch {} }
    };
    res.once('finish', record);
    res.once('close', record);
    if (active >= MAX_ACTIVE) { respond(res, 503, 'Busy\n', 'rate_limit'); return; }
    const now = Date.now();
    while (rateTimes.length && rateTimes[0] <= now - 60_000) rateTimes.shift();
    if (rateTimes.length >= config.limits.requestsPerMinute) { respond(res, 429, 'Rate limited\n', 'rate_limit'); return; }
    rateTimes.push(now);
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once('close', release);
    res.once('finish', release);
    if (mcpServer) handleMcp(req, res, mcpServer, requestImpl);
    else handleChat(req, res, config, requestImpl, release);
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
  return { socketPath, auditSnapshot: () => audit.map(entry => ({ ...entry })), close: async () => {
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
