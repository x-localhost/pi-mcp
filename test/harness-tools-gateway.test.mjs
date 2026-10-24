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
  let releaseFirstOverlap;
  const requestImpl = (options, callback) => {
    upstream.push(options);
    const req = new PassThrough();
    req.setTimeout = () => req;
    req.on('finish', () => {
      const respond = () => { const reply = new PassThrough();
        reply.statusCode = 200; reply.headers = { 'content-type': 'application/json' };
        callback(reply); reply.end('{}'); };
      if (upstream.length === 3) releaseFirstOverlap = respond;
      else { respond(); if (upstream.length === 4) releaseFirstOverlap(); }
    });
    return req;
  };
  const gateway = await startGateway({ config: validateGatewayConfig(config), socketPath, requestImpl });
  const body = JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hello' }] });
  const callDetailed = headers => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, requestId: res.headers['x-request-id'] }));
    });
    req.on('error', reject); req.end(body);
  });
  const call = async headers => (await callDetailed(headers)).status;
  try {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const requestId = '22222222-2222-4222-8222-222222222222';
    const attemptId = '33333333-3333-4333-8333-333333333333';
    assert.equal(await call({ 'x-pi-job-id': jobId, 'x-pi-request-id': requestId, 'x-pi-attempt-id': attemptId }), 200);
    assert.equal(gateway.auditSnapshot()[0].jobId, jobId);
    assert.equal(gateway.auditSnapshot()[0].providerRequestId, requestId);
    assert.equal(gateway.auditSnapshot()[0].providerCallId, attemptId);
    assert.equal(await call({ 'x-pi-job-id': jobId, 'x-pi-request-id': requestId, 'x-pi-attempt-id': attemptId }), 200);
    assert.notEqual(gateway.auditSnapshot()[0].requestId, gateway.auditSnapshot()[1].requestId);
    assert.equal(gateway.auditSnapshot()[1].providerCallId, attemptId);
    assert.equal(gateway.auditSnapshot()[1].observedRepeatOfCall, true);
    const overlappingId = '44444444-4444-4444-8444-444444444444';
    const overlappingHeaders = { 'x-pi-job-id': jobId, 'x-pi-request-id': overlappingId, 'x-pi-attempt-id': attemptId };
    const firstOverlap = callDetailed(overlappingHeaders);
    const secondOverlap = callDetailed(overlappingHeaders);
    const [firstResult, secondResult] = await Promise.all([firstOverlap, secondOverlap]);
    assert.equal(firstResult.status, 200); assert.equal(secondResult.status, 200);
    const overlapAudit = gateway.auditSnapshot().filter(entry => entry.providerRequestId === overlappingId);
    assert.equal(overlapAudit.length, 2);
    assert.equal(overlapAudit.find(entry => entry.requestId === firstResult.requestId).observedRepeatOfCall, undefined);
    assert.equal(overlapAudit.find(entry => entry.requestId === secondResult.requestId).observedRepeatOfCall, true);
    assert.equal(Object.keys(upstream[0].headers).some(name => name.toLowerCase().startsWith('x-pi-')), false);
    assert.equal(await call({ 'x-pi-job-id': jobId }), 400);
    assert.equal(await call({ 'x-pi-job-id': 'SENTINEL', 'x-pi-request-id': requestId, 'x-pi-attempt-id': attemptId }), 400);
    assert.equal(await call({ 'x-pi-job-id': [jobId, jobId], 'x-pi-request-id': requestId, 'x-pi-attempt-id': attemptId }), 400);
    assert.equal(upstream.length, 4);
  } finally { await gateway.close(); await rm(dir, { recursive: true, force: true }); }
});
