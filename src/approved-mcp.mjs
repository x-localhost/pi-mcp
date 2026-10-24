import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const TOOL = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROPERTY = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_ARGS_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_HTTP_BYTES = 64 * 1024;
const MAX_TOOLS = 16;
const MAX_SERVERS = 4;
const MCP_VERSION = '2025-11-25';
export const POLICY_READY_TIMEOUT_MS = 30_000;
const MCP_STARTUP_BUDGET_MS = 25_000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const fail = () => { throw new Error('Invalid approved MCP configuration'); };
const jsonBytes = value => { try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Infinity; } };

function normalizeSchema(raw, depth = 0) {
  if (depth > 8 || !exact(raw, ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'description', 'title'])) fail();
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(raw.type)) fail();
  const out = { type: raw.type };
  if (raw.description !== undefined) { if (typeof raw.description !== 'string' || raw.description.length > 512) fail(); out.description = raw.description; }
  if (raw.title !== undefined) { if (typeof raw.title !== 'string' || raw.title.length > 128) fail(); out.title = raw.title; }
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || !raw.enum.length || raw.enum.length > 32 || raw.enum.some(value => plain(value) || Array.isArray(value))) fail();
    out.enum = structuredClone(raw.enum);
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (raw[key] !== undefined) { if (!Number.isInteger(raw[key]) || raw[key] < 0 || raw[key] > 16384) fail(); out[key] = raw[key]; }
  }
  for (const key of ['minimum', 'maximum']) {
    if (raw[key] !== undefined) { if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) fail(); out[key] = raw[key]; }
  }
  if (raw.type === 'object') {
    if (raw.properties !== undefined && (!plain(raw.properties) || Object.keys(raw.properties).length > 64)) fail();
    out.properties = {};
    for (const [name, child] of Object.entries(raw.properties ?? {})) {
      if (!PROPERTY.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) fail();
      Object.defineProperty(out.properties, name, { value: normalizeSchema(child, depth + 1), enumerable: true, writable: true });
    }
    if (raw.required !== undefined && (!Array.isArray(raw.required) || raw.required.length > 64 || raw.required.some(name => typeof name !== 'string' || !(name in out.properties)) || new Set(raw.required).size !== raw.required.length)) fail();
    out.required = raw.required ? [...raw.required] : [];
    if (raw.additionalProperties !== undefined && raw.additionalProperties !== false) fail();
    out.additionalProperties = false;
    if (raw.items !== undefined) fail();
  } else if (raw.type === 'array') {
    if (raw.properties !== undefined || raw.required !== undefined || raw.additionalProperties !== undefined || raw.items === undefined) fail();
    out.items = normalizeSchema(raw.items, depth + 1);
  } else if (raw.properties !== undefined || raw.required !== undefined || raw.additionalProperties !== undefined || raw.items !== undefined) fail();
  return out;
}

export function validateMcpToolDeclarations(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_TOOLS) fail();
  const names = new Set();
  return raw.map(tool => {
    if (!exact(tool, ['name', 'description', 'inputSchema']) || typeof tool.name !== 'string' || !TOOL.test(tool.name) || names.has(tool.name) || typeof tool.description !== 'string' || !tool.description || tool.description.length > 512) fail();
    names.add(tool.name);
    const inputSchema = normalizeSchema(tool.inputSchema);
    if (inputSchema.type !== 'object' || jsonBytes(inputSchema) > MAX_SCHEMA_BYTES) fail();
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

export function validateApprovedMcp(raw) {
  if (raw === undefined) return { servers: [] };
  if (!exact(raw, ['servers']) || !Array.isArray(raw.servers) || raw.servers.length > MAX_SERVERS) fail();
  const ids = new Set();
  const servers = raw.servers.map(server => {
    if (!plain(server) || typeof server.id !== 'string' || !ID.test(server.id) || ids.has(server.id) || !['stdio', 'internal-http'].includes(server.transport)) fail();
    ids.add(server.id);
    const tools = validateMcpToolDeclarations(server.tools);
    if (!Array.isArray(server.reviewTools) || new Set(server.reviewTools).size !== server.reviewTools.length || server.reviewTools.some(name => typeof name !== 'string' || !tools.some(tool => tool.name === name))) fail();
    const common = { id: server.id, transport: server.transport, tools, reviewTools: [...server.reviewTools] };
    if (server.transport === 'internal-http') {
      if (!exact(server, ['id', 'transport', 'tools', 'reviewTools', 'backendAttested', 'route']) || server.backendAttested !== true) fail();
      const route = `/internal-mcp/${server.id}`;
      if (server.route !== undefined && server.route !== route) fail();
      return { ...common, backendAttested: true, route };
    }
    if (!exact(server, ['id', 'transport', 'tools', 'reviewTools', 'command', 'args', 'cwd', 'env'])) fail();
    if (typeof server.command !== 'string' || !server.command.startsWith('/') || server.command.includes('\0') || !Array.isArray(server.args) || server.args.length > 8 || server.args.some(arg => typeof arg !== 'string' || arg.length > 256 || /[\x00-\x1f]/.test(arg)) || typeof server.cwd !== 'string' || !server.cwd.startsWith('/') || server.cwd.includes('\0') || !plain(server.env) || Object.keys(server.env).length > 8) fail();
    for (const [name, value] of Object.entries(server.env)) if (!/^MCP_[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f]/.test(value)) fail();
    return { ...common, command: server.command, args: [...server.args], cwd: server.cwd, env: { ...server.env } };
  });
  const generated = servers.flatMap(server => server.tools.map(tool => `mcp__${server.id}__${tool.name}`));
  if (new Set(generated).size !== generated.length) fail();
  return { servers };
}

export function approvedMcpToolNames(config, mode) {
  if (!config || !Array.isArray(config.servers) || !['implement', 'review'].includes(mode)) return [];
  return config.servers.flatMap(server => server.tools.filter(tool => mode === 'implement' || server.reviewTools.includes(tool.name)).map(tool => `mcp__${server.id}__${tool.name}`));
}

function checkValue(schema, value, depth = 0) {
  if (depth > 8) return false;
  const type = schema.type;
  if (type === 'object') {
    if (!plain(value) || Object.keys(value).length > 64 || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(value, key))) return false;
    for (const [key, child] of Object.entries(value)) if (!checkValue(schema.properties[key], child, depth + 1)) return false;
  } else if (type === 'array') {
    if (!Array.isArray(value) || value.length > 128 || (schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems) || value.some(item => !checkValue(schema.items, item, depth + 1))) return false;
  } else if (type === 'string') {
    if (typeof value !== 'string' || value.length > 16384 || (schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength)) return false;
  } else if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isSafeInteger(value)) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) return false;
  } else if (type === 'boolean') { if (typeof value !== 'boolean') return false; }
  else if (type === 'null') { if (value !== null) return false; }
  if (schema.enum && !schema.enum.some(entry => Object.is(entry, value))) return false;
  return true;
}

export function validateToolArguments(schema, args) {
  return jsonBytes(args) <= MAX_ARGS_BYTES && checkValue(schema, args);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}

export function pinnedMcpDiscovery(declared, discovered) {
  if (!Array.isArray(discovered) || discovered.length !== declared.length) return false;
  const byName = new Map(discovered.map(tool => [tool.name, tool]));
  if (byName.size !== declared.length) return false;
  return declared.every(tool => {
    const found = byName.get(tool.name);
    if (!found || found.description !== tool.description) return false;
    try { return JSON.stringify(canonical(normalizeSchema(found.inputSchema))) === JSON.stringify(canonical(tool.inputSchema)); }
    catch { return false; }
  });
}

function immutablePackaged(server) {
  const canonical = value => typeof value === 'string' && value.startsWith('/') && path.posix.normalize(value) === value && !value.endsWith('/') && !value.split('/').includes('.') && !value.split('/').includes('..');
  const allowed = value => canonical(value) && (value === '/app/approved-mcp' || value.startsWith('/app/approved-mcp/'));
  if (!(allowed(server.command) || server.command === '/usr/local/bin/node') || !allowed(server.cwd)) return false;
  if (server.command === '/usr/local/bin/node' && (server.args.length !== 1 || !allowed(server.args[0]))) return false;
  const paths = [server.command, server.cwd, ...server.args.filter(arg => arg.startsWith('/'))];
  for (const target of paths) {
    if (target !== '/usr/local/bin/node' && !allowed(target)) return false;
    let cursor = '';
    for (const part of target.split('/').filter(Boolean)) {
      cursor += `/${part}`;
      let stat;
      try { stat = fs.lstatSync(cursor); } catch { return false; }
      if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (cursor === target ? !(target === server.cwd ? stat.isDirectory() : stat.isFile()) : !stat.isDirectory())) return false;
    }
  }
  return true;
}

function boundedResult(result) {
  if (!plain(result) || !Array.isArray(result.content) || result.content.length > 16 || jsonBytes(result) > MAX_RESULT_BYTES) throw new Error('Approved MCP result rejected');
  const content = result.content.map(part => {
    if (!exact(part, ['type', 'text', 'annotations', '_meta']) || part.type !== 'text' || typeof part.text !== 'string' || Buffer.byteLength(part.text) > MAX_RESULT_BYTES) throw new Error('Approved MCP result rejected');
    return { type: 'text', text: part.text };
  });
  return { content, details: undefined, isError: result.isError === true };
}

export async function httpRpc(server, message, signal, deadlineMs = 10_000) {
  const data = Buffer.from(JSON.stringify(message));
  if (data.length > MAX_HTTP_BYTES) throw new Error('Approved MCP request too large');
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { req.destroy(); reject(error); }
      else resolve(value);
    };
    const req = http.request({ hostname: '127.0.0.1', port: 18080, method: 'POST', path: server.route, agent: false, timeout: deadlineMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Accept: 'application/json' }, signal }, res => {
      if (res.headers['mcp-session-id'] !== undefined) { finish(new Error('Approved MCP session protocol rejected')); return; }
      const notification = message.id === undefined && res.statusCode === 202;
      if (!notification && (res.statusCode !== 200 || !/^application\/json(?:\s*;.*)?$/i.test(res.headers['content-type'] ?? ''))) { finish(new Error('Approved MCP unavailable')); return; }
      let bytes = 0; const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_HTTP_BYTES) finish(new Error('Approved MCP response too large')); else chunks.push(chunk); });
      res.on('end', () => {
        if (res.complete === false || (notification && bytes !== 0)) { finish(new Error('Approved MCP protocol error')); return; }
        if (notification) { finish(null, null); return; }
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString())); } catch { finish(new Error('Approved MCP protocol error')); }
      });
      res.on('aborted', () => finish(new Error('Approved MCP protocol error')));
      res.on('close', () => { if (res.complete === false) finish(new Error('Approved MCP protocol error')); });
      res.on('error', () => finish(new Error('Approved MCP protocol error')));
    });
    timer = setTimeout(() => finish(new Error('Approved MCP timeout')), deadlineMs);
    req.on('timeout', () => finish(new Error('Approved MCP timeout')));
    req.on('error', () => finish(new Error('Approved MCP unavailable')));
    req.end(data);
  });
}

async function startHttp(server, signal, deadline) {
  let id = 0;
  const rpc = async (method, params, callSignal, timeoutMs) => {
    const requestId = ++id;
    const reply = await httpRpc(server, { jsonrpc: '2.0', id: requestId, method, params }, callSignal, timeoutMs);
    if (!exact(reply, ['jsonrpc', 'id', 'result', 'error']) || reply.jsonrpc !== '2.0' || reply.id !== requestId || !plain(reply.result) || reply.error !== undefined) throw new Error('Approved MCP protocol error');
    return reply.result;
  };
  const startup = (method, params) => rpc(method, params, signal, Math.max(1, deadline - Date.now()));
  const initialize = await startup('initialize', { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'pi-mcp-approved', version: '1.0.0' } });
  if (initialize.protocolVersion !== MCP_VERSION || !plain(initialize.capabilities) || !plain(initialize.serverInfo)) throw new Error('Approved MCP protocol error');
  await httpRpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, signal, Math.max(1, deadline - Date.now()));
  const listed = await startup('tools/list', {});
  if (!pinnedMcpDiscovery(server.tools, listed.tools)) throw new Error('Approved MCP discovery mismatch');
  return { call: (name, args, callSignal) => rpc('tools/call', { name, arguments: args }, callSignal, 10_000), close: async () => {} };
}

async function startStdio(server, signal, deadline) {
  if (!immutablePackaged(server)) throw new Error('Approved MCP executable is not immutable and packaged');
  const client = new Client({ name: 'pi-mcp-approved', version: '1.0.0' }, { capabilities: {} });
  client.fallbackRequestHandler = () => { throw new Error('Server callbacks are disabled'); };
  for (const method of ['ping', 'tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel']) client.removeRequestHandler(method);
  const env = { HOME: '/tmp', LOGNAME: 'mcp', PATH: '/usr/bin:/bin', SHELL: '/bin/false', TERM: 'dumb', USER: 'mcp', ...server.env };
  const transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: server.cwd, env, stderr: 'ignore', maxBufferSize: MAX_HTTP_BYTES });
  const remaining = () => Math.max(1, deadline - Date.now());
  const aborted = () => new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new Error('Approved MCP startup aborted')); return; }
    signal.addEventListener('abort', () => reject(new Error('Approved MCP startup aborted')), { once: true });
  });
  try {
    await Promise.race([client.connect(transport), aborted()]);
    const listed = await Promise.race([client.listTools(undefined, { timeout: remaining(), signal }), aborted()]);
    if (listed.nextCursor || !pinnedMcpDiscovery(server.tools, listed.tools)) throw new Error('Approved MCP discovery mismatch');
    return { call: (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { timeout: 10_000, signal }), close: () => client.close() };
  } catch (error) { await client.close().catch(() => {}); throw error; }
}

export async function registerApprovedMcp(pi, policy, { connectSession } = {}) {
  const config = validateApprovedMcp(policy.approvedMcp);
  if (!config.servers.length) return { toolNames: [], close: async () => {} };
  const names = approvedMcpToolNames(config, policy.mode);
  const activeServers = config.servers.filter(server => server.tools.some(tool => policy.mode === 'implement' || server.reviewTools.includes(tool.name)));
  if (!activeServers.length) return { toolNames: [], close: async () => {} };
  const existing = new Set((pi.getAllTools?.() ?? []).map(tool => tool.name));
  if (names.some(name => existing.has(name))) throw new Error('Approved MCP tool collision');
  const sessions = [];
  const controller = new AbortController();
  const deadline = Date.now() + MCP_STARTUP_BUDGET_MS;
  const timer = setTimeout(() => controller.abort(new Error('Approved MCP startup timeout')), MCP_STARTUP_BUDGET_MS);
  try {
    const attempts = activeServers.map(async server => {
      const session = connectSession ? await connectSession(server, controller.signal, deadline) : server.transport === 'stdio' ? await startStdio(server, controller.signal, deadline) : await startHttp(server, controller.signal, deadline);
      if (controller.signal.aborted) { await session.close().catch(() => {}); throw new Error('Approved MCP startup aborted'); }
      sessions.push({ server, session, active: 0 });
    });
    await Promise.all(attempts).catch(async error => {
      controller.abort(error);
      await Promise.allSettled(attempts);
      throw error;
    });
    for (const { server, session } of sessions) {
      for (const tool of server.tools) {
        const name = `mcp__${server.id}__${tool.name}`;
        if (!names.includes(name)) continue;
        const state = sessions.find(entry => entry.server.id === server.id);
        pi.registerTool({ name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
          async execute(_id, args, signal) {
            if (!validateToolArguments(tool.inputSchema, args)) throw new Error('Approved MCP arguments rejected');
            if (state.active >= 2) throw new Error('Approved MCP busy');
            state.active++;
            try { return boundedResult(await session.call(tool.name, args, signal)); }
            finally { state.active--; }
          } });
      }
    }
    return { toolNames: names, close: async () => { await Promise.all(sessions.map(({ session }) => session.close().catch(() => {}))); } };
  } catch (error) { controller.abort(error); await Promise.all(sessions.map(({ session }) => session.close().catch(() => {}))); throw error; }
  finally { clearTimeout(timer); }
}
