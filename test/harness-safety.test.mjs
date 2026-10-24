import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authorizeTool, confinedPath } from '../src/policy.mjs';
import { scanState } from '../src/storage.mjs';
import { Manager } from '../src/manager.mjs';

const piCli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));

test('released Pi denies file URI write before external marker mutation', { timeout: 45000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-safety-real-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  const marker = path.join(root, 'outside-marker');
  let calls = 0;
  const gateway = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (calls === 1) {
      const chunk = { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'write-marker', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: `file://${marker}`, content: 'escaped' }) } }] }, finish_reason: null }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Denied.' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  let manager, start;
  try {
    const modelsFile = path.join(root, 'models.json');
    await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY', models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    manager = await new Manager({ stateDir: path.join(root, 'state'), allowedRoots: [root], maxConcurrent: 1, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 60,
      defaultMaxTurns: 3, piPath: process.execPath, piArgs: [piCli], modelsFile },
    { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', MOCK_API_KEY: 'test-only-key' }).init();
    start = await manager.start({ repository, title: 'URI safety', prompt: 'Try the requested write', provider: 'mock', model: 'mock', mode: 'implement' });
    let status;
    for (let i = 0; i < 100; i++) { status = await manager.status(start.id); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(status.status, 'completed', JSON.stringify(status));
    const result = await manager.result(start.id);
    assert.ok(result.permissionDenials.some(item => item.toolName === 'write'));
    assert.equal(await fs.stat(marker).then(() => true, () => false), false);
  } finally {
    if (manager && start) {
      const current = await manager.status(start.id).catch(() => null);
      if (current && ['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(current.status)) await manager.cancel(start.id).catch(() => {});
    }
    await new Promise(resolve => gateway.close(resolve));
  }
});

test('policy rejects file URI spellings before Pi resolves them', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-safety-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  const external = path.join(root, 'outside-marker');
  await fs.writeFile(external, 'external');
  // Pi maps this URI to `external`; path.resolve maps it to this decoy.
  const lexicalDecoy = path.join(root, 'file:', external.slice(1));
  await fs.mkdir(path.dirname(lexicalDecoy), { recursive: true });
  await fs.writeFile(lexicalDecoy, 'decoy');
  for (const value of ['file:///tmp/marker', 'file://localhost/tmp/marker', 'file://%2Egit/config', 'file:///repo/%2Egit/config']) {
    assert.equal(await confinedPath(root, value, true), false, value);
    assert.equal((await authorizeTool({ mode: 'implement', worktree: root }, 'read', { path: value })).allow, false, value);
    assert.equal((await authorizeTool({ mode: 'review', worktree: root }, 'read', { path: value })).allow, false, value);
  }
  const reviewRead = await authorizeTool({ mode: 'review', worktree: root }, 'read', { path: `file://${external}` });
  assert.equal(reviewRead.allow, false);
  assert.equal(await fs.readFile(external, 'utf8'), 'external');
  assert.equal(await confinedPath(root, 'normal.txt', true), true);
  assert.equal(await confinedPath(root, path.join(root, 'normal.txt'), true), true);
});

test('state scan counts symlink metadata without traversing targets and health remains available', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-safety-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  await fs.mkdir(state);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'large'), Buffer.alloc(4096));
  const links = path.join(state, 'links'); await fs.mkdir(links);
  await fs.symlink(outside, path.join(links, 'external-link'));
  const observed = await scanState(state);
  assert.equal(observed.withinLimit, true);
  assert.ok(observed.entries >= 2);
  assert.ok(observed.bytes < 4096);

  const manager = await new Manager({ stateDir: state, allowedRoots: [root], maxConcurrent: 1,
    defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60, defaultMaxTurns: 2, piPath: process.execPath, piArgs: [piCli],
    allowedCommands: [], provider: 'mock', model: 'mock', queue: { maxPending: 3, maxWaitSeconds: 30, dispatchIntervalMs: 100 },
    retention: { maxStateBytes: 1048576, maxScanEntries: 1000 } },
  { PATH: process.env.PATH }, { spawnWorker: false }).init();
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  await fs.symlink('base.txt', path.join(repository, 'tracked-link'));
  git('add', 'tracked-link'); git('commit', '-qm', 'add internal symlink');
  const first = await manager.start({ repository, title: 'first', prompt: 'first' });
  await manager.dispatchOnce();
  assert.equal(await fs.readlink(path.join(first.worktree, 'tracked-link')), 'base.txt');
  await manager.start({ repository, title: 'second', prompt: 'second' });
  assert.equal((await manager.health()).storage.withinLimit, true);
});
