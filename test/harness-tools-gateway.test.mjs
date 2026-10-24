import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateGatewayConfig, startGateway } from '../internal-agent/gateway.mjs';

test('gateway validates diagnostic UUIDs and consumes them before upstream', async () => {
  const config = { upstreamUrl: 'https://llm.corp.invalid/v1/chat/completions', upstreamAddress: '10.2.3.4', model: 'mock', limits: { maxOutputTokens: 128 } };
  assert.throws(() => validateGatewayConfig({ ...config, headers: { 'X-Pi-Job-Id': 'anything' } }), /invalid gateway configuration/i);
  const dir = await mkdtemp(join(tmpdir(), 'harness-gateway-'));
  const socketPath = join(dir, 'gateway.sock');
  const upstream = [];
  const requestImpl = (options, callback) => {
    upstream.push(options);
    const req = new PassThrough();
    req.setTimeout = () => req;
    req.on('finish', () => {
      const reply = new PassThrough();
      reply.statusCode = 200; reply.headers = { 'content-type': 'application/json' };
      callback(reply); reply.end('{}');
    });
    return req;
  };
  const gateway = await startGateway({ config: validateGatewayConfig(config), socketPath, requestImpl });
  const body = JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hello' }] });
  const call = headers => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const requestId = '22222222-2222-4222-8222-222222222222';
    const attemptId = '33333333-3333-4333-8333-333333333333';
    assert.equal(await call({ 'x-pi-job-id': jobId, 'x-pi-request-id': requestId, 'x-pi-attempt-id': attemptId }), 200);
    assert.equal(gateway.auditSnapshot()[0].jobId, jobId);
    assert.equal(gateway.auditSnapshot()[0].providerRequestId, requestId);
    assert.equal(gateway.auditSnapshot()[0].attemptId, attemptId);
    assert.equal(Object.keys(upstream[0].headers).some(name => name.toLowerCase().startsWith('x-pi-')), false);
    assert.equal(await call({ 'x-pi-job-id': jobId }), 400);
    assert.equal(await call({ 'x-pi-job-id': 'SENTINEL', 'x-pi-request-id': requestId, 'x-pi-attempt-id': attemptId }), 400);
    assert.equal(await call({ 'x-pi-job-id': [jobId, jobId], 'x-pi-request-id': requestId, 'x-pi-attempt-id': attemptId }), 400);
    assert.equal(upstream.length, 1);
  } finally { await gateway.close(); await rm(dir, { recursive: true, force: true }); }
});
