// Round-trip proof that configured corporate custom headers actually reach the
// provider HTTP request, using a loopback OpenAI-compatible mock gateway and the
// released Pi 1.4.0 binary (same pattern as test/real-pi.test.mjs). This is a
// baseline/confirmation test: docs/corporate-headers-plan.md records that
// models.json provider/model `headers` already pass through Pi today, so this
// test is expected to demonstrate existing forwarding (not new pi-mcp behavior).
// It requires the installed @earendil-works/pi-coding-agent bundle and therefore
// only runs where node_modules is present (gram, per the plan); it cannot be
// executed locally in this phase (no local npm/install permitted).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Manager } from '../src/manager.mjs';

const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('released Pi 1.4.0 forwards configured custom headers and existing Bearer auth to the mock gateway', { timeout: 30000 }, async () => {
  let requests = 0;
  let observedHeaders;
  const gateway = http.createServer(async (req, res) => {
    requests++;
    observedHeaders = req.headers;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Header round trip completed.' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-real-headers-'));
  try {
    const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Test only.'); git('add', '.'); git('commit', '-qm', 'base');
    const modelsFile = path.join(tmp, 'models.json');
    await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: {
      baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY',
      headers: { 'X-Corp-Client': '$CORP_CLIENT_ID', 'X-Corp-Trace': 'trace-${CORP_TRACE_ID}' },
      models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    } } }));
    const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 1, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 60,
      defaultMaxTurns: 2, piPath: process.execPath, piArgs: [cli], modelsFile, allowedCommands: [] },
      { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', MOCK_API_KEY: 'test-only-key', CORP_CLIENT_ID: 'client-42', CORP_TRACE_ID: 'trace-99' }).init();
    const start = await manager.start({ repository, title: 'Real Pi header round trip', prompt: 'Respond briefly.', provider: 'mock', model: 'mock' });
    let status;
    for (let i = 0; i < 100; i++) { status = await manager.status(start.id); if (!['starting', 'running'].includes(status.status)) break; await pause(100); }
    assert.equal(status.status, 'completed', JSON.stringify(await manager.result(start.id)));
    assert.equal(requests, 1);
    // Normal Bearer compatibility: a configured apiKey still produces Pi's own
    // Authorization header when no custom Authorization header overrides it.
    assert.equal(observedHeaders.authorization, 'Bearer test-only-key');
    // Multiple custom headers, including an embedded ${NAME} reference, reach the request.
    assert.equal(observedHeaders['x-corp-client'], 'client-42');
    assert.equal(observedHeaders['x-corp-trace'], 'trace-trace-99');
  } finally { await new Promise(resolve => gateway.close(resolve)); }
});

test('a custom Authorization header takes precedence over Pi\'s SDK-generated Bearer header', { timeout: 30000 }, async () => {
  let observedHeaders;
  const gateway = http.createServer(async (req, res) => {
    observedHeaders = req.headers;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Custom auth completed.' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-real-headers-auth-'));
  try {
    const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Test only.'); git('add', '.'); git('commit', '-qm', 'base');
    const modelsFile = path.join(tmp, 'models.json');
    await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: {
      baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY',
      headers: { Authorization: 'Token $CORP_CUSTOM_TOKEN' },
      models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    } } }));
    const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 1, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 60,
      defaultMaxTurns: 2, piPath: process.execPath, piArgs: [cli], modelsFile, allowedCommands: [] },
      { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', MOCK_API_KEY: 'test-only-key', CORP_CUSTOM_TOKEN: 'custom-token-value' }).init();
    const start = await manager.start({ repository, title: 'Custom auth header', prompt: 'Respond briefly.', provider: 'mock', model: 'mock' });
    let status;
    for (let i = 0; i < 100; i++) { status = await manager.status(start.id); if (!['starting', 'running'].includes(status.status)) break; await pause(100); }
    assert.equal(status.status, 'completed', JSON.stringify(await manager.result(start.id)));
    // Unverified-until-run: docs/corporate-headers-plan.md explicitly warns not to
    // claim the SDK's automatic Authorization is suppressed without proof. This
    // asserts the configured custom value is actually what the gateway observed;
    // if Pi instead sends both or a different precedence, this will fail here
    // (on gram, with node_modules present) rather than being assumed in docs.
    assert.equal(observedHeaders.authorization, 'Token custom-token-value');
  } finally { await new Promise(resolve => gateway.close(resolve)); }
});
