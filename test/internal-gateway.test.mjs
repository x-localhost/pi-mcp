import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateGatewayConfig, validateChatBody, startGateway } from '../internal-agent/gateway.mjs';
import { startRelay } from '../internal-agent/relay.mjs';

const base = { upstreamUrl: 'https://llm.corp.example:9443/v1/chat/completions', upstreamAddress: '10.2.3.4', model: 'corp-model', headers: { Authorization: 'Bearer $CORP_KEY' } };
const env = { CORP_KEY: 'gateway-secret' };
const body = { model: 'corp-model', messages: [{ role: 'user', content: 'Read https://example.com as text' }], stream: true };

function badConfig(patch) { assert.throws(() => validateGatewayConfig({ ...base, ...patch }, { env }), /invalid gateway configuration/i); }

test('configuration pins a private HTTPS target and resolves credentials only from gateway env', () => {
  const config = validateGatewayConfig(base, { env });
  assert.equal(config.address, '10.2.3.4');
  assert.equal(config.hostname, 'llm.corp.example');
  assert.equal(config.port, 9443);
  assert.equal(config.path, '/v1/chat/completions');
  assert.equal(config.headers.Authorization, 'Bearer gateway-secret');
  for (const address of ['8.8.8.8', '127.0.0.1', '169.254.1.1', '224.0.0.1', '0.0.0.0', '10.2.3.999', '::1']) badConfig({ upstreamAddress: address });
  for (const upstreamUrl of ['http://llm.corp.example/v1/chat/completions', 'https://u:p@llm.corp.example/v1/chat/completions', 'https://*.corp.example/v1/chat/completions', 'https://llm.corp.example/v1/chat/completions?x=1', 'https://llm.corp.example/other', 'https://127.0.0.1/v1/chat/completions', 'https://llm.corp.example/a/../v1/chat/completions', 'https://llm.corp.example/%61/v1/chat/completions', 'https://llm.corp.example//v1/chat/completions']) badConfig({ upstreamUrl });
  assert.equal(validateGatewayConfig({ ...base, upstreamUrl: 'https://llm.corp.example:9443/api/v1/chat/completions' }, { env }).path, '/api/v1/chat/completions');
  badConfig({ model: 'm'.repeat(121) });
  badConfig({ extra: true });
  badConfig({ headers: { Host: 'evil.example' } });
  badConfig({ headers: { 'Proxy-Authorization': 'x' } });
  badConfig({ headers: { Authorization: '!print-secret' } });
  badConfig({ headers: { Authorization: '$(print-secret)' } });
  badConfig({ headers: { Authorization: '${BAD NAME}' } });
  badConfig({ headers: { Authorization: '$MISSING' } });
  badConfig({ headers: { Authorization: '$CORP_KEY\r\nBad: x' } });
  for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'NPM_CONFIG_USERCONFIG', 'PI_CODING_AGENT_DIR', 'HTTPS_PROXY', 'HOME', 'PATH', 'SSH_AUTH_SOCK', 'OPENSSL_CONF', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    assert.throws(() => validateGatewayConfig({ ...base, headers: { Authorization: `$${name}` } }, { env: { [name]: 'unsafe' } }), /invalid gateway configuration/i);
  }
});

test('CLI startup failure is generic and contains no config path or secret', () => {
  const gatewayPath = fileURLToPath(new URL('../internal-agent/gateway.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [gatewayPath, '/missing/private-token.json', '/tmp/gateway.sock'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Gateway startup failed\n');
  assert.equal(result.stdout, '');
});

test('chat request schema rejects routing, remote media and server tools', () => {
  assert.equal(validateChatBody(body, 'corp-model').model, 'corp-model');
  for (const invalid of [
    { ...body, model: 'other' },
    { ...body, web_search_options: {} },
    { ...body, provider: 'outside' },
    { ...body, tools: [{ type: 'web_search' }] },
    { ...body, tools: [{ type: 'function', function: { name: 'f', parameters: {} } }, { type: 'browser' }] },
    { ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://evil.example/x.png' } }] }] },
    { ...body, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }] }] },
  ]) assert.throws(() => validateChatBody(invalid, 'corp-model'), /invalid chat request/i);
  const inline = { ...body, messages: [{ role: 'user', content: [{ type: 'text', text: 'https://example.com' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] };
  assert.deepEqual(validateChatBody(inline, 'corp-model'), inline);
  const functionRoundTrip = { ...body, messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
  ], tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a local file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] };
  assert.deepEqual(validateChatBody(functionRoundTrip, 'corp-model'), functionRoundTrip);
});

test('Pi store:false is accepted but retention and unknown store values are rejected', () => {
  const piBody = { ...body, store: false, max_completion_tokens: 512 };
  assert.deepEqual(validateChatBody(piBody, 'corp-model'), piBody);
  for (const store of [true, null, 'false', 0]) assert.throws(() => validateChatBody({ ...body, store }, 'corp-model'), /invalid chat request/i);
});

test('schema references stay within local fragments for all ref keywords', () => {
  const tool = schema => ({ ...body, tools: [{ type: 'function', function: { name: 'read_file', parameters: schema } }] });
  const format = schema => ({ ...body, response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } });
  for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
    const local = { type: 'object', properties: { value: { [keyword]: '#/$defs/value' } }, $defs: { value: { type: 'string' } } };
    assert.deepEqual(validateChatBody(tool(local), 'corp-model'), tool(local));
    assert.deepEqual(validateChatBody(format(local), 'corp-model'), format(local));
    for (const remote of ['https://outside.example/schema', '//outside.example/schema', 'other.json#/$defs/value']) {
      const schema = { type: 'object', properties: { value: { [keyword]: remote } } };
      assert.throws(() => validateChatBody(tool(schema), 'corp-model'), /invalid chat request/i);
      assert.throws(() => validateChatBody(format(schema), 'corp-model'), /invalid chat request/i);
    }
  }
});

// Retry/validation is on by default now, so a success-case default response
// must be a real completion (not placeholder text) or it would be retried
// and ultimately answered 503 instead of 200.
async function fixture(response = { statusCode: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'secret=1', location: 'https://evil.example' }, chunks: ['data: {"choices":[{"delta":{"content":"one"}}]}\n\n', 'data: [DONE]\n\n'] }, rawConfig = base) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-test-'));
  const socketPath = join(dir, 'gateway.sock');
  const seen = [];
  const requestImpl = (options, callback) => {
    const request = new PassThrough();
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('finish', () => {
      seen.push({ options, body: Buffer.concat(chunks).toString() });
      if (response.hang) return;
      const reply = new PassThrough();
      reply.statusCode = response.statusCode;
      reply.headers = response.headers;
      callback(reply);
      for (const chunk of response.chunks ?? []) reply.write(chunk);
      reply.end();
    });
    request.setTimeout = (_ms, callback) => { if (response.hang) queueMicrotask(callback); return request; };
    request.destroy = error => {
      if (response.hang) { if (error) queueMicrotask(() => request.emit('error', error)); return request; }
      return PassThrough.prototype.destroy.call(request, error);
    };
    return request;
  };
  const gateway = await startGateway({ config: validateGatewayConfig(rawConfig, { env }), socketPath, requestImpl });
  const call = (method, path, data = null, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers: data === null ? headers : { 'content-type': 'application/json', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
  return { seen, call, socketPath, close: async () => { await gateway.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('gateway accepts only fixed routes, methods and bounded valid JSON', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('GET', '/healthz')).status, 200);
    for (const [method, path] of [['GET', '/v1/chat/completions'], ['POST', '/other'], ['POST', 'http://evil.example/v1/chat/completions']]) {
      assert.notEqual((await f.call(method, path)).status, 200);
    }
    const connectReply = await new Promise((resolve, reject) => {
      const client = net.createConnection(f.socketPath);
      let data = '';
      client.setTimeout(1000, () => client.destroy(new Error('CONNECT did not close')));
      client.on('connect', () => client.write('CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example\r\n\r\n'));
      client.on('data', chunk => { data += chunk; });
      client.on('close', () => resolve(data));
      client.on('error', reject);
    });
    assert.equal(connectReply, '');
    assert.equal((await f.call('POST', '/v1/chat/completions', '{bad')).status, 400);
    assert.equal((await f.call('POST', '/v1/chat/completions', JSON.stringify({ ...body, tools: [{ type: 'web_search' }] }))).status, 400);
    assert.equal((await f.call('POST', '/v1/chat/completions', '', { 'content-length': String(4 * 1024 * 1024 + 1) })).status, 413);
    assert.equal(f.seen.length, 0);
  } finally { await f.close(); }
});

test('gateway strips client headers, pins upstream and streams success with minimal response headers', async () => {
  const f = await fixture();
  try {
    const result = await f.call('POST', '/v1/chat/completions', JSON.stringify(body), { host: 'evil.example', authorization: 'Bearer attacker', 'proxy-authorization': 'proxy-secret', 'x-forwarded-host': 'evil.example', 'content-type': 'application/json' });
    assert.equal(result.status, 200);
    assert.equal(result.body, 'data: {"choices":[{"delta":{"content":"one"}}]}\n\ndata: [DONE]\n\n');
    assert.equal(result.headers['content-type'], 'text/event-stream');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers.location, undefined);
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].options.hostname, '10.2.3.4');
    assert.equal(f.seen[0].options.servername, 'llm.corp.example');
    assert.equal(f.seen[0].options.rejectUnauthorized, true);
    assert.equal(f.seen[0].options.headers.Host, 'llm.corp.example:9443');
    assert.equal(f.seen[0].options.headers.Authorization, 'Bearer gateway-secret');
    assert.equal(f.seen[0].options.headers['proxy-authorization'], undefined);
    assert.equal(f.seen[0].options.headers['x-forwarded-host'], undefined);
    assert.deepEqual(JSON.parse(f.seen[0].body), { ...body, max_completion_tokens: 4096 });
  } finally { await f.close(); }
});

test('administrator prefix changes only the fixed upstream path', async () => {
  const f = await fixture({ statusCode: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"choices":[{"message":{"content":"ok"}}]}'] }, { ...base, upstreamUrl: 'https://llm.corp.example:9443/api/v1/chat/completions' });
  try {
    assert.equal((await f.call('POST', '/v1/chat/completions', JSON.stringify(body))).status, 200);
    assert.equal(f.seen[0].options.path, '/api/v1/chat/completions');
    assert.equal((await f.call('POST', '/api/v1/chat/completions', JSON.stringify(body))).status, 404);
    assert.equal(f.seen.length, 1);
  } finally { await f.close(); }
});

test('upstream redirects and errors return generic text without upstream reflection', async () => {
  // This test is about a single upstream attempt's failure, not retry
  // behaviour, so maxAttempts is pinned to 1. 302/401 are never retried
  // regardless of maxAttempts, so they still answer immediately as 502; 500
  // is retryable by category, so exhausting the one allowed attempt reports
  // its own exhaustion as 503 rather than reflecting the upstream status
  // directly as 502 (matching "503 then 200 is retried" semantics elsewhere).
  for (const [statusCode, expectedStatus] of [[302, 502], [401, 502], [500, 503]]) {
    const f = await fixture({ statusCode, headers: { location: 'https://evil.example', 'set-cookie': 'secret=1' }, chunks: ['upstream-secret'] }, { ...base, retry: { maxAttempts: 1 } });
    try {
      const result = await f.call('POST', '/v1/chat/completions', JSON.stringify(body));
      assert.equal(result.status, expectedStatus);
      assert.equal(result.body.includes('upstream-secret'), false);
      assert.equal(result.headers.location, undefined);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(f.seen.length, 1);
    } finally { await f.close(); }
  }
});

test('upstream idle timeout returns a generic error', async () => {
  // A timeout before headers is retryable by category; maxAttempts is
  // pinned to 1 so this test stays about one upstream attempt. Exhausting
  // that one allowed attempt reports 503 (see the comment above), not 502.
  const f = await fixture({ hang: true }, { ...base, retry: { maxAttempts: 1 } });
  try {
    const result = await f.call('POST', '/v1/chat/completions', JSON.stringify(body));
    assert.equal(result.status, 503);
    assert.equal(result.body, 'Upstream unavailable\n');
  } finally { await f.close(); }
});

test('relay binds loopback and forwards to its fixed Unix socket', async () => {
  const f = await fixture();
  const relay = await startRelay({ socketPath: f.socketPath, port: 0 });
  try {
    assert.equal(relay.address, '127.0.0.1');
    assert.ok(relay.port > 0);
    const result = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${relay.port}/healthz`, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
    assert.equal(result, 200);
  } finally { await relay.close(); await f.close(); }
});

test('relay returns a generic failure when its fixed gateway socket is absent', async () => {
  const relay = await startRelay({ socketPath: '/tmp/nonexistent-pi-internal-gateway.sock', port: 0 });
  try {
    const result = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${relay.port}/healthz`, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
    assert.equal(result, 502);
  } finally { await relay.close(); }
});
