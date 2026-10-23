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

test('released Pi executes grep and find with real rg/fd and returns tool results', { timeout: 30000 }, async () => {
  let requests = 0;
  const toolsSeen = [];
  const gateway = http.createServer(async (req, res) => {
    requests++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.ok(body.tools.some(tool => tool.function?.name === 'grep'));
    assert.ok(body.tools.some(tool => tool.function?.name === 'find'));
    const toolMessages = body.messages.filter(message => message.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests === 1) {
      assert.equal(toolMessages.length, 0);
      toolsSeen.push('grep');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-grep', type: 'function', function: { name: 'grep', arguments: '{"pattern":"RegressionNeedle","path":"."}' } }] }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
    } else if (requests === 2) {
      assert.ok(toolMessages.some(message => JSON.stringify(message).includes('RegressionNeedle')),
        `grep result missing from second request: ${JSON.stringify(toolMessages)}`);
      toolsSeen.push('find');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-find', type: 'function', function: { name: 'find', arguments: '{"pattern":"*.txt","path":"."}' } }] }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
    } else {
      assert.ok(toolMessages.some(message => JSON.stringify(message).includes('target.txt')),
        `find result missing from third request: ${JSON.stringify(toolMessages)}`);
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'grep/find completed.' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-regression-tools-'));
  try {
    const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Read-only tool acceptance.\n');
    await fs.writeFile(path.join(repository, 'target.txt'), 'RegressionNeedle\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const modelsFile = path.join(tmp, 'models.json');
    await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY',
      models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 1,
      defaultTimeoutSeconds: 15, maxTimeoutSeconds: 60, defaultMaxTurns: 3,
      piPath: process.execPath, piArgs: [cli], modelsFile, allowedCommands: [] },
      { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', MOCK_API_KEY: 'test-only-key' }).init();
    const health = await manager.health();
    assert.deepEqual(health.requiredTools, { rg: true, fd: true });
    assert.equal(requests, 0, 'health made a provider request');
    const start = await manager.start({ repository, title: 'Real grep/find', prompt: 'Inspect target.txt.', provider: 'mock', model: 'mock', mode: 'review' });
    let status;
    for (let i = 0; i < 150; i++) {
      status = await manager.status(start.id);
      if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) break;
      await pause(100);
    }
    assert.equal(status.status, 'completed', JSON.stringify(await manager.result(start.id)));
    assert.equal(requests, 3);
    assert.deepEqual(toolsSeen, ['grep', 'find']);
    assert.match((await manager.result(start.id)).result, /grep\/find completed/);
  } finally {
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
  }
});
