import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Manager } from '../src/manager.mjs';

const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exercise({ mode, tool, args, allowedCommands = [], cancel = false }) {
  let requests = 0;
  const gateway = http.createServer(async (req, res) => {
    requests++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (requests === 1) {
      assert.equal(body.tools.some(entry => entry.function?.name === 'bash'), false);
      assert.equal(body.tools.some(entry => entry.function?.name === 'write'), mode === 'implement');
      assert.equal(body.tools.some(entry => entry.function?.name === 'safe_shell'), mode === 'implement');
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests === 1) {
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-tool', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-policy-real-'));
  try {
    const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
    const git = (...items) => execFileSync('git', ['-C', repository, ...items], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Initial.'); git('add', '.'); git('commit', '-qm', 'base');
    const modelsFile = path.join(tmp, 'models.json');
    await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY',
      models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 1, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 60,
      defaultMaxTurns: 3, piPath: process.execPath, piArgs: [cli], modelsFile, allowedCommands },
      { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', MOCK_API_KEY: 'test-only-key' }).init();
    const start = await manager.start({ repository, title: 'Policy', prompt: 'Do task', provider: 'mock', model: 'mock', mode });
    if (cancel) {
      for (let i = 0; i < 70 && requests < 1; i++) await delay(100);
      await delay(350); await manager.cancel(start.id);
    }
    let status;
    for (let i = 0; i < 100; i++) { status = await manager.status(start.id); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) break; await delay(100); }
    return { status, result: await manager.result(start.id), worktree: start.worktree, requests };
  } finally { await new Promise(resolve => gateway.close(resolve)); }
}

test('real Pi implements write and exact safe_shell command', { timeout: 45000 }, async () => {
  const write = await exercise({ mode: 'implement', tool: 'write', args: { path: 'new.txt', content: 'new content' } });
  assert.equal(write.status.status, 'completed', JSON.stringify(write.result));
  assert.equal(await fs.readFile(path.join(write.worktree, 'new.txt'), 'utf8'), 'new content');
  const edit = await exercise({ mode: 'implement', tool: 'edit', args: { path: 'AGENTS.md', edits: [{ oldText: 'Initial.', newText: 'Updated.' }] } });
  assert.equal(edit.status.status, 'completed', JSON.stringify(edit.result));
  assert.equal(await fs.readFile(path.join(edit.worktree, 'AGENTS.md'), 'utf8'), 'Updated.');
  const command = 'printf approved > shell.txt';
  const shell = await exercise({ mode: 'implement', tool: 'safe_shell', args: { command }, allowedCommands: [command] });
  assert.equal(shell.status.status, 'completed', JSON.stringify(shell.result));
  assert.equal(await fs.readFile(path.join(shell.worktree, 'shell.txt'), 'utf8'), 'approved');
});

test('real Pi review blocks write and shell cancellation stops process group', { timeout: 45000 }, async () => {
  const review = await exercise({ mode: 'review', tool: 'write', args: { path: 'new.txt', content: 'bad' } });
  assert.equal(await fs.stat(path.join(review.worktree, 'new.txt')).then(() => true, () => false), false);
  const denied = await exercise({ mode: 'implement', tool: 'write', args: { path: '.git/config', content: 'bad' } });
  assert.ok(denied.result.permissionDenials.some(item => item.toolName === 'write'));
  const shell = await exercise({ mode: 'implement', tool: 'safe_shell', args: { command: 'sleep 20' }, allowedCommands: ['sleep 20'], cancel: true });
  assert.equal(shell.status.status, 'cancelled', JSON.stringify(shell.result));
});

test('real Pi denies @-normalized absolute write before the tool resolves it', { timeout: 45000 }, async () => {
  const outside = path.join(os.tmpdir(), `pi-policy-escape-${randomUUID()}`);
  const denied = await exercise({ mode: 'implement', tool: 'write', args: { path: `@${outside}`, content: 'escape' } });
  assert.ok(denied.result.permissionDenials.some(item => item.toolName === 'write'));
  assert.equal(await fs.stat(outside).then(() => true, () => false), false);
});
