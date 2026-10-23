// Actual private HTTPS gateway checks; no public endpoint, prompts, or secrets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { validateGatewayConfig, startGateway } from '/app/internal-agent/gateway.mjs';

const address = Object.values(os.networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
assert.match(address, /^(?:10\.|172\.|192\.168\.)/);
const server = https.createServer({ key: fs.readFileSync('/fixture/key.pem'), cert: fs.readFileSync('/fixture/cert.pem') }, async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  requests++;
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (body.messages?.[0]?.content === 'redirect') {
    res.writeHead(302, { Location: 'https://unapproved.example.invalid/v1/chat/completions', 'Content-Type': 'text/plain' });
    res.end('should not escape');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
  }
});
let requests = 0;
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));

async function one({ hostname = 'mock.corp.internal', ca = true, prompt = 'ping' }) {
  const config = validateGatewayConfig({ upstreamUrl: `https://${hostname}:${server.address().port}/v1/chat/completions`, upstreamAddress: address, model: 'approved-model',
    ...(ca ? { caFile: '/fixture/cert.pem' } : {}), headers: {} });
  const socketPath = `/tmp/gateway-tls-${process.pid}.sock`;
  const gateway = await startGateway({ config, socketPath });
  try {
    const data = JSON.stringify({ model: 'approved-model', messages: [{ role: 'user', content: prompt }], stream: false, store: false });
    return await new Promise((resolve, reject) => {
      const request = http.request({ socketPath, path: '/v1/chat/completions', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', error => resolve({ status: 0, code: error.code }));
      request.end(data);
    });
  } finally { await gateway.close(); }
}

try {
  console.log('tls_case=valid');
  assert.equal((await one({})).status, 200);
  assert.equal(requests, 1);
  console.log('tls_case=missing_ca');
  const missingCa = await one({ ca: false });
  console.log(`missing_ca_result=${missingCa.status || missingCa.code}`);
  assert.equal(missingCa.status, 502);
  assert.equal(requests, 1);
  console.log('tls_case=wrong_name');
  const wrongName = await one({ hostname: 'wrong.corp.internal' });
  console.log(`wrong_name_result=${wrongName.status || wrongName.code}`);
  assert.equal(wrongName.status, 502);
  assert.equal(requests, 1);
  console.log('tls_case=redirect');
  const redirect = await one({ prompt: 'redirect' });
  console.log(`redirect_result=${redirect.status || redirect.code}`);
  assert.equal(redirect.status, 502);
  assert.equal(redirect.body, 'Upstream unavailable\n');
  assert.equal(requests, 2);
  console.log('tls_valid=200 missing_ca=502 wrong_name=502 redirect=502 upstream_requests=2');
} finally { server.close(); }
