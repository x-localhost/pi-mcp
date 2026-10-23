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
test('released Pi 1.4.0 runs with explicit policy and local mock gateway', { timeout: 30000 }, async () => {
  let requests = 0;
  const gateway = http.createServer(async (req, res) => {
    requests++;
    assert.equal(req.method, 'POST');
    assert.match(req.url, /chat\/completions/);
    assert.equal(req.headers.authorization, 'Bearer test-only-key');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.ok(body.tools.some(tool => tool.function?.name === 'read'));
    assert.equal(body.tools.some(tool => tool.function?.name === 'bash'), false);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests === 1) {
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'read', arguments: '{"path":"AGENTS.md"}' } }] }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
    } else {
      assert.ok(body.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('Test only')));
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Mock gateway completed.' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-real-'));
  try {
    const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Test only.'); git('add', '.'); git('commit', '-qm', 'base');
    const modelsFile = path.join(tmp, 'models.json');
    await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY',
      models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 1, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 60,
      defaultMaxTurns: 2, piPath: process.execPath, piArgs: [cli], modelsFile, allowedCommands: [] },
      { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', MOCK_API_KEY: 'test-only-key' }).init();
    const start = await manager.start({ repository, title: 'Real Pi mock', prompt: 'Respond briefly.', provider: 'mock', model: 'mock' });
    let status;
    for (let i = 0; i < 100; i++) { status = await manager.status(start.id); if (!['starting', 'running'].includes(status.status)) break; await pause(100); }
    assert.equal(status.status, 'completed', JSON.stringify(await manager.result(start.id)));
    assert.equal(requests, 2);
    assert.match((await manager.result(start.id)).result, /Mock gateway completed/);
  } finally { await new Promise(resolve => gateway.close(resolve)); }
});
