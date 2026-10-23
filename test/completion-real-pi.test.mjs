import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Manager } from '../src/manager.mjs';
import { loadConfig, buildChildEnv } from '../src/config.mjs';

const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitJob(manager, id, predicate, limit = 300) {
  for (let i = 0; i < limit; i++) { const job = await manager.read(id); if (predicate(job)) return job; await delay(100); }
  throw new Error(`Job ${id} did not reach expected state`);
}

test('released Pi 1.4.0 forks original immutable session/code after followup and ACKs steering via local mock', { timeout: 120000 }, async t => {
  let requests = 0;
  const gateway = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only-key');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests++;
    const serialized = JSON.stringify(body.messages || []);
    if (serialized.includes('[STEER_HOLD]') && !serialized.includes('steering-message-marker')) await delay(1200);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'runtime-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: `Local mock response ${requests}` }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'runtime-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-real-completion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Local mock test only.\n'); git('add', '.'); git('commit', '-qm', 'base');
  const modelsFile = path.join(root, 'models.json');
  await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ piPath: process.execPath, piArgs: [cli], stateDir: path.join(root, 'state'), allowedRoots: [root],
    modelsFile, envAllowlist: ['MOCK_API_KEY'], provider: 'mock', model: 'mock', maxConcurrent: 1, defaultTimeoutSeconds: 20, maxTimeoutSeconds: 30, defaultMaxTurns: 3,
    queue: { maxPending: 3, maxWaitSeconds: 30, dispatchIntervalMs: 100 } }));
  const config = await loadConfig(configFile);
  const manager = await new Manager(config, buildChildEnv(config, { ...process.env, MOCK_API_KEY: 'test-only-key' })).init();
  const originalStart = await manager.start({ repository, title: 'Original', prompt: 'Reply briefly.' });
  const original = await waitJob(manager, originalStart.id, job => ['completed', 'failed', 'quarantined'].includes(job.status));
  assert.equal(original.status, 'completed', JSON.stringify(original));
  await fs.writeFile(path.join(original.worktree, 'later.txt'), 'later\n');
  const followStart = await manager.start({ prompt: 'Continue briefly.' }, original.id);
  const follow = await waitJob(manager, followStart.id, job => ['completed', 'failed', 'quarantined'].includes(job.status));
  assert.equal(follow.status, 'completed', JSON.stringify(follow));
  const forkStart = await manager.fork(original.id, { prompt: 'Reply from the original branch.' });
  const fork = await waitJob(manager, forkStart.id, job => ['completed', 'failed', 'quarantined'].includes(job.status));
  assert.equal(fork.status, 'completed', JSON.stringify(fork));
  assert.notEqual(fork.worktree, original.worktree); assert.notEqual(fork.sessionDir, original.sessionDir);
  assert.equal(await fs.stat(path.join(fork.worktree, 'later.txt')).then(() => true, () => false), false);
  assert.equal(fork.inputSnapshotDigest, original.artifacts.inputSnapshotDigest);
  const steerStart = await manager.start({ repository, title: 'Steer', prompt: '[STEER_HOLD] Reply briefly.' });
  await waitJob(manager, steerStart.id, job => job.status === 'running' && !!job.sessionFile);
  const ack = await manager.steer(steerStart.id, { message: 'steering-message-marker' });
  assert.ok(['queued_by_pi', 'handled_by_pi'].includes(ack.status), JSON.stringify(ack));
  const steered = await waitJob(manager, steerStart.id, job => ['completed', 'failed', 'quarantined'].includes(job.status));
  assert.equal(steered.status, 'completed', JSON.stringify(steered));
  assert.ok(requests >= 4);
});
