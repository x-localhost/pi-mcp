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

test('seedAgent rejects command credentials in auth key and tokens', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-auth-'));
  const authFile = path.join(tmp, 'auth.json');
  const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], authFile }, {}).init();
  for (const credential of [{ key: '!echo leak' }, { access: '!echo leak' }, { refresh: '!echo leak' }]) {
    await fs.writeFile(authFile, JSON.stringify({ provider: { type: 'api_key', ...credential } }));
    await assert.rejects(manager.seedAgent(), /Command-bearing credential/);
  }
});

test('model-only override inherits configured provider; provider override requires model', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-model-'));
  const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 2, defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 60, defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [], provider: 'configured', model: 'default' }, {}, { spawnWorker: false }).init();
  const modelOnly = await manager.start({ repository, title: 'Model override', prompt: 'Run', model: 'alternate' });
  assert.equal((await manager.read(modelOnly.id)).provider, 'configured');
  assert.equal((await manager.read(modelOnly.id)).model, 'alternate');
  await assert.rejects(manager.start({ repository, title: 'Provider override', prompt: 'Run', provider: 'other' }), /provider.*model/i);
});

test('manager canonicalizes a symlinked state directory before allocating worktrees', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-state-link-'));
  const actual = path.join(tmp, 'actual');
  const alias = path.join(tmp, 'alias');
  await fs.mkdir(actual); await fs.symlink(actual, alias);
  const manager = await new Manager({ stateDir: alias, allowedRoots: [tmp] }, {}).init();
  assert.equal(manager.config.stateDir, actual);
  assert.equal(manager.worktreesDir, path.join(actual, 'worktrees'));
  assert.equal(manager.agentDir, path.join(actual, 'agent'));
});

test('health reports only existing auth sources or configured credential env', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-health-auth-'));
  const authFile = path.join(tmp, 'missing-auth.json');
  const config = { stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], piPath: '/bin/echo', piArgs: ['1.4.0'], authFile, envAllowlist: ['CORP_AUTH'] };
  const manager = await new Manager(config, { PATH: process.env.PATH }).init();
  assert.equal((await manager.health()).authenticationPresent, false);
  await fs.writeFile(authFile, '{}');
  assert.equal((await manager.health()).authenticationPresent, true);
  await fs.rm(authFile);
  manager.childEnv.CORP_AUTH = 'test-only-key';
  assert.equal((await manager.health()).authenticationPresent, true);
});
