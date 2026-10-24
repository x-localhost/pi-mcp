import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateGatewayConfig, startGateway } from '../internal-agent/gateway.mjs';
import { startRelay } from '../internal-agent/relay.mjs';

test('relay carries only valid chat trace trio to gateway and never forwards private headers upstream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-final-relay-'));
  const socketPath = join(dir, 'gateway.sock');
  const upstream = [];
  const requestImpl = (options, callback) => {
    upstream.push(options);
    const peer = new PassThrough(); peer.setTimeout = () => peer;
    peer.on('finish', () => {
      const response = new PassThrough();
      response.statusCode = 200; response.headers = { 'content-type': 'application/json' };
      callback(response); response.end('{}');
    });
    return peer;
  };
  const gateway = await startGateway({ config: validateGatewayConfig({
    upstreamUrl: 'https://llm.corp.invalid/v1/chat/completions', upstreamAddress: '10.2.3.4', model: 'mock',
    limits: { maxOutputTokens: 128 }
  }), socketPath, requestImpl });
  const relay = await startRelay({ socketPath, port: 0 });
  const body = JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hello' }] });
  const call = (headers, route = '/v1/chat/completions') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: relay.port, method: 'POST', path: route,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    const trace = {
      'x-pi-job-id': '11111111-1111-4111-8111-111111111111',
      'x-pi-request-id': '22222222-2222-4222-8222-222222222222',
      'x-pi-attempt-id': '33333333-3333-4333-8333-333333333333'
    };
    assert.equal(await call({ ...trace, authorization: 'Bearer private', 'x-private': 'secret' }), 200);
    const audit = gateway.auditSnapshot();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].jobId, trace['x-pi-job-id']);
    assert.equal(audit[0].providerRequestId, trace['x-pi-request-id']);
    assert.equal(audit[0].providerCallId, trace['x-pi-attempt-id']);
    assert.equal(upstream.length, 1);
    assert.equal(Object.keys(upstream[0].headers).some(name => /^(?:authorization|x-private|x-pi-)/i.test(name)), false);
    assert.equal(await call({ 'x-pi-job-id': trace['x-pi-job-id'] }), 400);
    assert.equal(await call({ ...trace, 'x-pi-request-id': 'invalid' }), 400);
    assert.equal(await call({ ...trace, 'x-pi-job-id': [trace['x-pi-job-id'], trace['x-pi-job-id']] }), 400);
    assert.equal(gateway.auditSnapshot().length, 1);
    assert.equal(await call(trace, '/internal-mcp/unknown'), 404);
    assert.equal(gateway.auditSnapshot().length, 1);
  } finally {
    await relay.close(); await gateway.close(); await rm(dir, { recursive: true, force: true });
  }
});
