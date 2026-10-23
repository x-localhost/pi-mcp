import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startGateway, validateGatewayConfig } from '../internal-agent/gateway.mjs';
import { startRelay } from '../internal-agent/relay.mjs';
import { registerApprovedMcp, httpRpc } from '../src/approved-mcp.mjs';

const tool = { name: 'read', description: 'Read a document', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } };
const approvedMcp = { servers: [{ id: 'docs', transport: 'internal-http', backendAttested: true, tools: [tool], reviewTools: ['read'] }] };
const gatewayRaw = { upstreamUrl: 'https://llm.corp.invalid/v1/chat/completions', upstreamAddress: '10.2.3.4', model: 'approved-model', headers: {}, mcpServers: [{ id: 'docs', upstreamUrl: 'https://docs.corp.invalid/mcp', upstreamAddress: '10.2.3.5', backendAttested: true, headers: { Authorization: 'Bearer $MCP_KEY' }, tools: [tool] }] };

async function fixture(discovered = [tool]) {
  const dir = await mkdtemp(join(tmpdir(), 'approved-mcp-bridge-'));
  const socketPath = join(dir, 'gateway.sock');
  const seen = [];
  const requestImpl = (options, callback) => {
    const request = new PassThrough(); const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('finish', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({ options, body });
      const response = new PassThrough();
      response.statusCode = body.method === 'notifications/initialized' ? 202 : 200;
      response.headers = body.method === 'notifications/initialized' ? {} : { 'content-type': 'application/json', 'set-cookie': 'do-not-forward=1' };
      callback(response);
      if (body.method === 'notifications/initialized') { response.end(); return; }
      const result = body.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '1.0.0' } }
        : body.method === 'tools/list' ? { tools: discovered }
          : body.method === 'tools/call' ? { content: [{ type: 'text', text: `DOC:${body.params.arguments.path}` }], isError: false }
            : {};
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    request.setTimeout = () => request;
    return request;
  };
  const gateway = await startGateway({ config: validateGatewayConfig(gatewayRaw, { env: { MCP_KEY: 'gateway-only-secret' } }), socketPath, requestImpl });
  const relay = await startRelay({ socketPath, port: 18080 });
  return { seen, close: async () => { await relay.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('approved internal HTTP tool discovers, executes and closes through fixed relay and gateway', async () => {
  const fixtureState = await fixture();
  const tools = [];
  try {
    const session = await registerApprovedMcp({ getAllTools: () => [], registerTool: definition => tools.push(definition) }, { mode: 'implement', approvedMcp });
    assert.deepEqual(session.toolNames, ['mcp__docs__read']);
    assert.deepEqual(tools.map(item => item.name), session.toolNames);
    const result = await tools[0].execute('call-1', { path: 'guide.md' });
    assert.deepEqual(result.content, [{ type: 'text', text: 'DOC:guide.md' }]);
    assert.deepEqual(fixtureState.seen.map(item => item.body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(fixtureState.seen.at(-1).options.hostname, '10.2.3.5');
    assert.equal(fixtureState.seen.at(-1).options.servername, 'docs.corp.invalid');
    assert.equal(fixtureState.seen.at(-1).options.headers.Authorization, 'Bearer gateway-only-secret');
    await assert.rejects(tools[0].execute('call-2', { path: 'guide.md', url: 'https://outside.invalid' }), /arguments rejected/i);
    assert.equal(fixtureState.seen.length, 4);
    await session.close();
  } finally { await fixtureState.close(); }
});

test('discovery mismatch and Pi tool-name collision fail before registering a tool', async () => {
  const fixtureState = await fixture([{ ...tool, description: 'changed' }]);
  const tools = [];
  try {
    await assert.rejects(registerApprovedMcp({ getAllTools: () => [], registerTool: definition => tools.push(definition) }, { mode: 'implement', approvedMcp }), /approved mcp unavailable/i);
    assert.equal(tools.length, 0);
    await assert.rejects(registerApprovedMcp({ getAllTools: () => [{ name: 'mcp__docs__read' }], registerTool: definition => tools.push(definition) }, { mode: 'implement', approvedMcp }), /collision/i);
    assert.equal(tools.length, 0);
  } finally { await fixtureState.close(); }
});

test('HTTP MCP client rejects session headers, notification bodies, truncated replies and total deadline', async () => {
  let behavior = 'session';
  const server = http.createServer((req, res) => {
    req.resume();
    if (behavior === 'session') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'opaque' }); res.end('{"jsonrpc":"2.0","id":1,"result":{}}'); }
    else if (behavior === 'notification') { res.writeHead(202, { 'content-type': 'application/json' }); res.end('unexpected'); }
    else if (behavior === 'truncated') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' }); res.write('{"jsonrpc":'); res.destroy(); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.write(' '); const ticker = setInterval(() => res.write(' '), 15); res.on('close', () => clearInterval(ticker)); }
  });
  await new Promise(resolve => server.listen(18080, '127.0.0.1', resolve));
  const endpoint = { route: '/internal-mcp/docs' };
  try {
    await assert.rejects(httpRpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, 100), /session|protocol/i);
    behavior = 'notification';
    await assert.rejects(httpRpc(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, undefined, 100), /protocol/i);
    behavior = 'truncated';
    await assert.rejects(httpRpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, 100), /protocol|unavailable|socket/i);
    behavior = 'deadline';
    await assert.rejects(httpRpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, 70), /timeout/i);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
