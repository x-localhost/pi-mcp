import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateGatewayConfig, enforceChatLimits, validateMcpRpc, startGateway } from '../internal-agent/gateway.mjs';
import { startRelay } from '../internal-agent/relay.mjs';

const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
const configRaw = { upstreamUrl: 'https://llm.corp.invalid/v1/chat/completions', upstreamAddress: '10.2.3.4', model: 'approved-model', headers: { Authorization: 'Bearer $LLM_KEY' },
  limits: { maxOutputTokens: 256, maxN: 1, requestsPerMinute: 2 },
  mcpServers: [{ id: 'docs', upstreamUrl: 'https://docs.corp.invalid/mcp', upstreamAddress: '10.2.3.5', headers: { Authorization: 'Bearer $MCP_KEY' }, backendAttested: true, tools: [{ name: 'read', description: 'Read a document', inputSchema: schema }] }] };
const env = { LLM_KEY: 'llm-secret', MCP_KEY: 'mcp-secret' };
const chat = { model: 'approved-model', messages: [{ role: 'user', content: 'hello' }], stream: true };

test('gateway validates fixed MCP route, pinned schemas and bounded limits', () => {
  const config = validateGatewayConfig(configRaw, { env });
  assert.equal(config.mcpServers[0].path, '/mcp');
  assert.equal(config.mcpServers[0].headers.Authorization, 'Bearer mcp-secret');
  assert.equal(config.limits.maxOutputTokens, 256);
  for (const invalid of [
    { ...configRaw, limits: { maxOutputTokens: 0 } },
    { ...configRaw, mcpServers: [{ ...configRaw.mcpServers[0], upstreamAddress: '8.8.8.8' }] },
    { ...configRaw, mcpServers: [{ ...configRaw.mcpServers[0], upstreamUrl: 'https://docs.corp.invalid/%6dcp' }] },
    { ...configRaw, mcpServers: [{ ...configRaw.mcpServers[0], backendAttested: false }] },
  ]) assert.throws(() => validateGatewayConfig(invalid, { env }), /invalid gateway configuration/i);
});

test('gateway pins output budget and one completion before forwarding', () => {
  const limits = validateGatewayConfig(configRaw, { env }).limits;
  assert.equal(enforceChatLimits(chat, limits).max_completion_tokens, 256);
  assert.throws(() => enforceChatLimits({ ...chat, n: 2 }, limits), /invalid chat request/i);
  assert.throws(() => enforceChatLimits({ ...chat, max_completion_tokens: 257 }, limits), /invalid chat request/i);
  assert.throws(() => enforceChatLimits({ ...chat, max_tokens: 200, max_completion_tokens: 200 }, limits), /invalid chat request/i);
});

test('gateway accepts only the stateless JSON-RPC subset and declared tool schema', () => {
  const server = validateGatewayConfig(configRaw, { env }).mcpServers[0];
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { path: 'guide.md' } } };
  assert.deepEqual(validateMcpRpc(call, server), call);
  for (const bad of [
    [call], { ...call, method: 'resources/read' }, { ...call, params: { name: 'other', arguments: {} } },
    { ...call, params: { name: 'read', arguments: { path: 'x', url: 'https://outside.invalid' } } },
    { ...call, id: null }, { jsonrpc: '2.0', method: 'sampling/createMessage', params: {} },
    { jsonrpc: '2.0', method: 'notifications/other' },
  ]) assert.throws(() => validateMcpRpc(bad, server), /invalid mcp request/i);
});

async function fixture(statusCode = 401, behavior = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'completion-gateway-'));
  const socketPath = join(dir, 'gateway.sock');
  const seen = [];
  const requestImpl = (options, callback) => {
    const request = new PassThrough(); const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('finish', () => {
      seen.push({ options, body: Buffer.concat(chunks).toString() });
      const response = new PassThrough(); response.statusCode = statusCode;
      response.headers = statusCode === 200 ? { 'content-type': 'application/json', 'set-cookie': 'leak=1' } : { 'content-type': 'application/json', location: 'https://outside.invalid', 'set-cookie': 'leak=1' };
      callback(response);
      if (behavior === 'partial-error') { response.write('partial'); setImmediate(() => response.destroy(new Error('upstream stream failed'))); return; }
      response.end(statusCode === 200 ? '{}' : 'secret-upstream-body');
    });
    request.setTimeout = () => request;
    return request;
  };
  const gateway = await startGateway({ config: validateGatewayConfig(configRaw, { env }), socketPath, requestImpl });
  const relay = await startRelay({ socketPath, port: 0 });
  const call = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: relay.port, method: 'POST', path, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(data);
  });
  return { seen, call, gateway, close: async () => { await relay.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('safe diagnostic category, request ID and per-minute cap do not leak upstream body', async () => {
  const f = await fixture(401);
  try {
    const first = await f.call('/v1/chat/completions', chat);
    assert.equal(first.status, 502);
    assert.equal(first.headers['x-gateway-category'], 'auth');
    assert.match(first.headers['x-request-id'], /^[a-f0-9-]{36}$/);
    assert.equal(first.body.includes('secret-upstream-body'), false);
    assert.equal(f.seen[0].options.headers.Authorization, 'Bearer llm-secret');
    assert.equal(JSON.parse(f.seen[0].body).max_completion_tokens, 256);
    await f.call('/v1/chat/completions', chat);
    const third = await f.call('/v1/chat/completions', chat);
    assert.equal(third.status, 429);
    assert.equal(third.headers['x-gateway-category'], 'rate_limit');
    assert.equal(f.seen.length, 2);
    const audit = f.gateway.auditSnapshot();
    assert.equal(audit.length, 3);
    assert.equal(JSON.stringify(audit).includes('secret'), false);
  } finally { await f.close(); }
});

test('relay accepts fixed internal MCP route but rejects arbitrary URL and CONNECT', async () => {
  const f = await fixture(500);
  try {
    const result = await f.call('/internal-mcp/docs', { jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
    assert.equal(result.status, 502);
    assert.equal(f.seen[0].options.hostname, '10.2.3.5');
    assert.equal(f.seen[0].options.servername, 'docs.corp.invalid');
    assert.equal(f.seen[0].options.headers.Authorization, 'Bearer mcp-secret');
    assert.equal((await f.call('http://outside.invalid/internal-mcp/docs', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404);
    assert.equal(f.seen.length, 1);
  } finally { await f.close(); }
});

test('gateway rejects a nonempty upstream MCP notification acknowledgement', async () => {
  const f = await fixture(202);
  try {
    const response = await f.call('/internal-mcp/docs', { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(response.status, 502);
    assert.equal(response.headers['x-gateway-category'], 'protocol');
    assert.equal(response.body.includes('secret-upstream-body'), false);
  } finally { await f.close(); }
});

test('chat and approved MCP requests consume the same bounded rate bucket', async () => {
  const f = await fixture(500);
  try {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping', params: {} };
    assert.equal((await f.call('/internal-mcp/docs', ping)).status, 502);
    assert.equal((await f.call('/v1/chat/completions', chat)).status, 502);
    const rejected = await f.call('/internal-mcp/docs', ping);
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers['x-gateway-category'], 'rate_limit');
    assert.equal(f.seen.length, 2);
  } finally { await f.close(); }
});

test('partial upstream chat stream is audited as aborted with failure category', async () => {
  const f = await fixture(200, 'partial-error');
  try {
    const result = await new Promise((resolve, reject) => {
      const data = JSON.stringify(chat);
      const req = http.request({ socketPath: f.gateway.socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
        res.resume();
        res.on('close', () => resolve({ status: res.statusCode, complete: res.complete }));
        res.on('error', () => {});
      });
      req.on('error', reject); req.end(data);
    });
    assert.equal(result.status, 200);
    assert.equal(result.complete, false);
    const audit = f.gateway.auditSnapshot();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].category, 'upstream');
    assert.equal(audit[0].status, 200);
    assert.equal(audit[0].completed, false);
    assert.equal(audit[0].aborted, true);
  } finally { await f.close(); }
});
