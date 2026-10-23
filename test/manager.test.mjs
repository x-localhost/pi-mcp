import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Manager } from '../src/manager.mjs';

test('manager starts from committed base and handles stable request IDs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-manager-'));
  const repo = path.join(tmp, 'repo'); const stateDir = path.join(tmp, 'state');
  await fs.mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, 'base.txt'), 'committed'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo, 'dirty.txt'), 'private');
  const manager = new Manager({ stateDir, allowedRoots: [tmp], maxConcurrent: 2, defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60, defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [] }, {}, { spawnWorker: false });
  await manager.init();
  const input = { repository: repo, title: 'Test', prompt: 'Do task', request_id: 'same', provider: 'mock', model: 'mock-model' };
  const first = await manager.start(input);
  assert.equal(first.baseCommit, base);
  assert.match(first.warning, /uncommitted/);
  assert.equal(await fs.access(path.join(first.worktree, 'dirty.txt')).then(() => true, () => false), false);
  assert.equal((await manager.start(input)).id, first.id);
  await assert.rejects(manager.start({ ...input, prompt: 'other' }), /different inputs/);
});

test('separate managers share a submission lock and concurrency count', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lock-'));
  const repo = path.join(tmp, 'repo'); await fs.mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, 'base.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  const config = { stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 1, defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60,
    defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [], provider: 'mock', model: 'mock' };
  const a = await new Manager(config, {}, { spawnWorker: false }).init();
  const b = await new Manager(config, {}, { spawnWorker: false }).init();
  const outcomes = await Promise.allSettled([
    a.start({ repository: repo, title: 'A', prompt: 'A' }),
    b.start({ repository: repo, title: 'B', prompt: 'B' })
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  assert.match(outcomes.find(item => item.status === 'rejected').reason.message, /Concurrency limit/);
});
