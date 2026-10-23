import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Manager } from '../src/manager.mjs';
import { validateConfig, buildChildEnv } from '../src/config.mjs';

const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('released Pi uses CONNECT proxy and configured CA for HTTPS model requests', { timeout: 45000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-proxy-'));
  const keyFile = path.join(tmp, 'key.pem'); const caFile = path.join(tmp, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', caFile,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  let connects = 0; let requests = 0;
  const gateway = https.createServer({ key: await fs.readFile(keyFile), cert: await fs.readFile(caFile) }, async (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer test-only-key');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model, 'mock');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'TLS proxy completed.' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer((_req, res) => { res.writeHead(502); res.end(); });
  proxy.on('connect', (req, client, head) => {
    connects++;
    const [host, portText] = req.url.split(':');
    const upstream = net.connect(Number(portText), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Proxy test.'); git('add', '.'); git('commit', '-qm', 'base');
    const modelsFile = path.join(tmp, 'models.json');
    await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: { baseUrl: `https://127.0.0.1:${gateway.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY',
      models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const source = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', MOCK_API_KEY: 'test-only-key', CORP_PROXY: proxyUrl };
    const raw = { piPath: process.execPath, piArgs: [cli], allowedRoots: [tmp], modelsFile, provider: 'mock', model: 'mock',
      maxConcurrent: 1, defaultTimeoutSeconds: 12, maxTimeoutSeconds: 30, defaultMaxTurns: 2, envAllowlist: ['MOCK_API_KEY'],
      network: { httpsProxyEnv: 'CORP_PROXY', caFile } };
    const config = validateConfig({ ...raw, stateDir: path.join(tmp, 'state-good') }, tmp);
    // This direct Manager fixture has no persisted config file for a dispatcher.
    delete config.queue;
    const manager = await new Manager(config, buildChildEnv(config, source)).init();
    assert.equal((await manager.health()).version, '1.4.0');
    assert.equal(connects, 0);
    const started = await manager.start({ repository, title: 'Proxy', prompt: 'Say hello.' });
    let status;
    for (let i = 0; i < 150; i++) { status = await manager.status(started.id); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) break; await delay(100); }
    assert.equal(status.status, 'completed', JSON.stringify(await manager.result(started.id)));
    assert.match((await manager.result(started.id)).result, /TLS proxy completed/);
    assert.ok(connects >= 1); assert.ok(requests >= 1);
    const successfulRequests = requests;
    const withoutCa = validateConfig({ ...raw, stateDir: path.join(tmp, 'state-bad'), network: { httpsProxyEnv: 'CORP_PROXY' } }, tmp);
    delete withoutCa.queue;
    const failed = await new Manager(withoutCa, buildChildEnv(withoutCa, source)).init();
    const negative = await failed.start({ repository, title: 'No CA', prompt: 'Say hello.' });
    for (let i = 0; i < 150; i++) { status = await failed.status(negative.id); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) break; await delay(100); }
    assert.ok(['failed', 'turn_limit', 'timed_out'].includes(status.status), JSON.stringify(await failed.result(negative.id)));
    assert.ok((await failed.result(negative.id)).result.length > 0);
    assert.ok(connects >= 2);
    assert.equal(requests, successfulRequests);
  } finally {
    proxy.closeAllConnections(); gateway.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => gateway.close(resolve))]);
  }
});
