import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGatewayConfig, startGateway } from '../internal-agent/gateway.mjs';

const base = { upstreamUrl: 'https://llm.corp.example:9443/v1/chat/completions', upstreamAddress: '10.2.3.4', model: 'corp-model', headers: { Authorization: 'Bearer $CORP_KEY' } };
const env = { CORP_KEY: 'gateway-secret' };
const streamBody = { model: 'corp-model', messages: [{ role: 'user', content: 'hi' }], stream: true };
const plainBody = { model: 'corp-model', messages: [{ role: 'user', content: 'hi' }] };

// Builds a mock requestImpl that replays a fixed sequence of upstream attempt
// descriptors in order (the last descriptor repeats if more attempts occur
// than descriptors provided). Mirrors the PassThrough-based seam used by
// test/internal-gateway.test.mjs.
function sequencedRequestImpl(attempts) {
  const calls = [];
  const impl = (options, callback) => {
    const i = Math.min(calls.length, attempts.length - 1);
    const descriptor = attempts[i];
    const record = { options, at: Date.now() };
    calls.push(record);
    const request = new PassThrough();
    const sent = [];
    request.on('data', chunk => sent.push(chunk));
    let destroyed = false;
    request.setTimeout = () => request;
    request.destroy = error => {
      if (destroyed) return request;
      destroyed = true;
      if (error) queueMicrotask(() => request.emit('error', error));
      else PassThrough.prototype.destroy.call(request);
      return request;
    };
    request.on('finish', () => {
      record.body = Buffer.concat(sent).toString();
      if (descriptor.networkError) { queueMicrotask(() => request.emit('error', descriptor.networkError)); return; }
      if (descriptor.hang) return;
      const reply = new PassThrough();
      reply.statusCode = descriptor.statusCode ?? 200;
      reply.headers = descriptor.headers ?? {};
      callback(reply);
      for (const chunk of descriptor.chunks ?? []) reply.write(chunk);
      if (descriptor.noEnd !== true) reply.end();
    });
    return request;
  };
  impl.calls = calls;
  return impl;
}

async function fixture({ rawConfig, requestImpl }) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-resilience-'));
  const socketPath = join(dir, 'gateway.sock');
  const gateway = await startGateway({ config: validateGatewayConfig(rawConfig, { env }), socketPath, requestImpl });
  const call = (body, headers = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    let gotResponse = false;
    const chunks = [];
    let status, resHeaders;
    const req = http.request({ socketPath, agent: false, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      gotResponse = true; status = res.statusCode; resHeaders = res.headers;
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status, headers: resHeaders, complete: res.complete, body: Buffer.concat(chunks).toString() }));
      // A server-side destroy after headers (cutting the connection post-commit)
      // surfaces here as a client-side socket reset; treat it as a terminal,
      // incomplete response rather than an unhandled rejection.
      res.on('error', () => resolve({ status, headers: resHeaders, complete: false, body: Buffer.concat(chunks).toString() }));
      res.on('close', () => resolve({ status, headers: resHeaders, complete: res.complete, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', error => { if (gotResponse) resolve({ status, headers: resHeaders, complete: false, body: Buffer.concat(chunks).toString() }); else reject(error); });
    // A server-side destroy after headers can surface as a raw socket "hang
    // up" that Node would otherwise throw as an unhandled error; the outcome
    // is already captured above via res/req, so just swallow it here.
    req.on('socket', socket => socket.on('error', () => {}));
    req.end(data);
  });
  // Like call() but hands back the live request so a test can abort it mid-flight.
  const callRaw = (body, headers = {}) => {
    const data = JSON.stringify(body);
    const chunks = [];
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    const req = http.request({ socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => settle({ status: res.statusCode, complete: res.complete, body: Buffer.concat(chunks).toString() }));
      res.on('error', () => settle({ status: res.statusCode, complete: res.complete, body: Buffer.concat(chunks).toString() }));
      res.on('close', () => settle({ status: res.statusCode, complete: res.complete, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', () => {});
    req.end(data);
    return { req, done };
  };
  // Issues the request over a raw net.Socket and returns everything received
  // before the connection closed, plus whether the server ended the TCP
  // connection itself (vs. the client choosing to stop reading). Avoids
  // Node's http.ClientRequest parser, which otherwise raises an internal
  // "socket hang up" error for a response destroyed mid-body regardless of
  // which EventEmitter a test attaches 'error' handlers to.
  const callRawSocket = (body, headers = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headerLines = Object.entries({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers }).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    const request = `POST /v1/chat/completions HTTP/1.1\r\nHost: gateway\r\n${headerLines}\r\n`;
    const client = net.createConnection(socketPath);
    let received = Buffer.alloc(0);
    client.on('connect', () => client.write(request + data));
    client.on('data', chunk => { received = Buffer.concat([received, chunk]); });
    client.on('error', () => {}); // a mid-body RST surfaces here; the outcome is read from `received`.
    client.on('close', () => resolve({ raw: received.toString() }));
    client.setTimeout(5000, () => { client.destroy(); reject(new Error('callRawSocket timed out')); });
  });
  return { call, callRaw, callRawSocket, socketPath, gateway, close: async () => { await gateway.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('empty SSE stream (finish_reason stop, no content) then valid: client sees only the valid stream, attempts=2', async () => {
  const requestImpl = sequencedRequestImpl([
    { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, chunks: ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'] },
    { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, chunks: ['data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n', 'data: [DONE]\n\n'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }, requestImpl });
  try {
    const result = await f.call(streamBody);
    assert.equal(result.status, 200);
    assert.equal(result.body, 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
    assert.equal(requestImpl.calls.length, 2);
    const audit = f.gateway.auditSnapshot();
    assert.equal(audit[0].attempts, 2);
    assert.equal(audit[0].category, 'ok');
  } finally { await f.close(); }
});

test('invalid JSON data line before commit is retried', async () => {
  const requestImpl = sequencedRequestImpl([
    { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, chunks: ['data: {bad json\n\n'] },
    { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, chunks: ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }, requestImpl });
  try {
    const result = await f.call(streamBody);
    assert.equal(result.status, 200);
    assert.ok(result.body.includes('"content":"ok"'));
    assert.equal(requestImpl.calls.length, 2);
    assert.equal(f.gateway.auditSnapshot()[0].attempts, 2);
  } finally { await f.close(); }
});

test('503 then 200 is retried; Retry-After is respected and capped', async () => {
  const requestImpl = sequencedRequestImpl([
    { statusCode: 503, headers: { 'retry-after': '5' } },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"choices":[{"message":{"content":"ok"}}]}'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 50 } }, requestImpl });
  try {
    const start = Date.now();
    const result = await f.call(plainBody);
    const elapsed = Date.now() - start;
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).choices[0].message.content, 'ok');
    assert.equal(requestImpl.calls.length, 2);
    assert.equal(f.gateway.auditSnapshot()[0].attempts, 2);
    assert.ok(elapsed < 500, `expected capped backoff, took ${elapsed}ms`);
  } finally { await f.close(); }
});

test('401 is not retried', async () => {
  const requestImpl = sequencedRequestImpl([
    { statusCode: 401, headers: {} },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"choices":[{"message":{"content":"ok"}}]}'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }, requestImpl });
  try {
    const result = await f.call(plainBody);
    assert.notEqual(result.status, 200);
    assert.equal(requestImpl.calls.length, 1);
    assert.equal(f.gateway.auditSnapshot()[0].attempts, 1);
  } finally { await f.close(); }
});

test('exhausted retries respond 503 with category malformed', async () => {
  const requestImpl = sequencedRequestImpl([
    { statusCode: 200, headers: { 'content-type': 'application/json' }, chunks: ['{}'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } }, requestImpl });
  try {
    const result = await f.call(plainBody);
    assert.equal(result.status, 503);
    assert.equal(result.body, 'Upstream unavailable: empty or malformed response\n');
    assert.equal(requestImpl.calls.length, 2);
    const audit = f.gateway.auditSnapshot();
    assert.equal(audit[0].category, 'malformed');
    assert.equal(audit[0].attempts, 2);
  } finally { await f.close(); }
});

test('non-stream JSON with empty choices is retried', async () => {
  const requestImpl = sequencedRequestImpl([
    { statusCode: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"choices":[]}'] },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"choices":[{"message":{"content":"ok"}}]}'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }, requestImpl });
  try {
    const result = await f.call(plainBody);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).choices[0].message.content, 'ok');
    assert.equal(requestImpl.calls.length, 2);
    assert.equal(f.gateway.auditSnapshot()[0].attempts, 2);
  } finally { await f.close(); }
});

test('malformed data line after commit destroys the client connection without forwarding garbage', async () => {
  const requestImpl = sequencedRequestImpl([
    { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, chunks: ['data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n', 'data: {bad json after commit\n\n'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }, requestImpl });
  try {
    const result = await f.callRawSocket(streamBody);
    assert.ok(result.raw.includes('"content":"Hello"'), 'good content before the cut should have been forwarded');
    assert.equal(result.raw.includes('bad json after commit'), false, 'the malformed line itself must never reach the client');
    // A proper chunked response ends with the "0\r\n\r\n" terminator chunk;
    // cutting the connection instead of forwarding garbage means that never arrives.
    assert.equal(result.raw.endsWith('0\r\n\r\n'), false, 'the connection must be cut, not cleanly finished');
    assert.equal(requestImpl.calls.length, 1);
    assert.equal(f.gateway.auditSnapshot()[0].attempts, 1);
  } finally { await f.close(); }
});

test('pre-commit SSE buffer bound (1 MiB) commits as-is instead of retrying', async () => {
  // Many syntactically valid but non-meaningful chunks (empty delta, no
  // finish_reason) that never trigger a commit on their own; once the
  // accumulated pre-commit buffer passes 1 MiB, the plan says to commit
  // as-is rather than keep buffering or retry. A trailing [DONE] lets the
  // attempt end cleanly afterward.
  const filler = 'data: {"choices":[{"delta":{}}]}\n\n';
  const repeatCount = Math.ceil((1024 * 1024 + 4096) / filler.length);
  const bigChunk = filler.repeat(repeatCount);
  assert.ok(Buffer.byteLength(bigChunk) > 1024 * 1024, 'fixture must actually exceed the 1 MiB bound');
  const requestImpl = sequencedRequestImpl([
    { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, chunks: [bigChunk, 'data: [DONE]\n\n'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }, requestImpl });
  try {
    const result = await f.call(streamBody);
    assert.equal(result.status, 200);
    assert.ok(Buffer.byteLength(result.body) > 1024 * 1024, 'the oversized buffer should have been committed as-is, not discarded');
    assert.ok(result.body.endsWith('data: [DONE]\n\n'), 'forwarding should continue normally post-commit through the clean end');
    assert.equal(requestImpl.calls.length, 1, 'exceeding the buffer bound commits; it must not be retried');
    assert.equal(f.gateway.auditSnapshot()[0].attempts, 1);
    assert.equal(f.gateway.auditSnapshot()[0].category, 'ok');
  } finally { await f.close(); }
});

test('rate limit slots are consumed per attempt and stop retrying when exhausted', async () => {
  const requestImpl = sequencedRequestImpl([
    { statusCode: 503, headers: {} },
    { statusCode: 503, headers: {} },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"choices":[{"message":{"content":"ok"}}]}'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, limits: { requestsPerMinute: 2 }, retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 } }, requestImpl });
  try {
    const result = await f.call(plainBody);
    // First inbound request already consumes slot 1 (attempt 1); attempt 2 consumes slot 2;
    // attempt 3 has no slot left, so retrying stops at 2 attempts instead of reaching the
    // third (would-be-successful) response or exhausting maxAttempts=5.
    assert.equal(result.status, 503);
    assert.equal(requestImpl.calls.length, 2);
    assert.equal(f.gateway.auditSnapshot()[0].attempts, 2);
  } finally { await f.close(); }
});

test('client disconnect during backoff cancels further upstream attempts', async () => {
  const requestImpl = sequencedRequestImpl([
    { statusCode: 503, headers: { 'retry-after': '2' } },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"choices":[{"message":{"content":"ok"}}]}'] },
  ]);
  const f = await fixture({ rawConfig: { ...base, retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1000 } }, requestImpl });
  try {
    const { req } = f.callRaw(plainBody);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(requestImpl.calls.length, 1, 'first attempt should have happened by now');
    req.destroy();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(requestImpl.calls.length, 1, 'client disconnect during backoff must cancel the pending retry');
  } finally { await f.close(); }
});

test('retry config validation rejects unknown keys and out-of-range values, and accepts the example file', async () => {
  for (const retry of [
    { maxAttempts: 3, extra: true },
    { maxAttempts: 0 },
    { maxAttempts: 6 },
    { maxAttempts: 1.5 },
    { baseDelayMs: -1 },
    { baseDelayMs: 10001 },
    { maxDelayMs: 30001 },
    { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 100 },
  ]) {
    assert.throws(() => validateGatewayConfig({ ...base, retry }, { env }), /invalid gateway configuration/i);
  }
  const withDefaults = validateGatewayConfig({ ...base, retry: {} }, { env });
  assert.deepEqual(withDefaults.retry, { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 });
  // Protection against empty/malformed responses is on by default: omitting
  // the `retry` key entirely must still produce the same defaults, not an
  // inert/disabled state.
  const withoutRetry = validateGatewayConfig(base, { env });
  assert.deepEqual(withoutRetry.retry, { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 });
  const disabledRetries = validateGatewayConfig({ ...base, retry: { maxAttempts: 1 } }, { env });
  assert.deepEqual(disabledRetries.retry, { maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 8000 });

  const examplePath = fileURLToPath(new URL('../internal-agent/gateway.example.json', import.meta.url));
  // caFile points at an administrator-provisioned path (docs/internal-agent.md)
  // that does not exist in this sandboxed test run; drop it so this test
  // exercises the example's retry/other fields without a real CA file on disk.
  const { caFile, ...example } = JSON.parse(await readFile(examplePath, 'utf8'));
  const exampleEnv = { CORP_LLM_API_KEY: 'x', CORP_CLIENT_ID: 'y' };
  const exampleConfig = validateGatewayConfig(example, { env: exampleEnv });
  assert.deepEqual(exampleConfig.retry, { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 });
});
