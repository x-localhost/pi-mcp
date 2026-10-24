import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Manager, atomicJson } from '../src/manager.mjs';

const helper = fileURLToPath(new URL('./regression-submit.mjs', import.meta.url));
async function fixture(maxConcurrent = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-regression-process-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const config = { stateDir: path.join(root, 'state'), allowedRoots: [root], maxConcurrent,
    defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60, defaultMaxTurns: 2,
    piPath: '/bin/true', allowedCommands: [], provider: 'mock', model: 'mock' };
  const base = git('rev-parse', 'HEAD');
  return { root, repo, config, base, git };
}

function runChild(config, input, barrier, parentId) {
  const child = spawn(process.execPath, [helper], {
    env: { ...process.env, REGRESSION_CONFIG: JSON.stringify(config), REGRESSION_INPUT: JSON.stringify(input),
      REGRESSION_BARRIER: barrier, REGRESSION_PARENT: parentId || '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(`child ${code}: ${err}`)));
  });
}

async function parallel(config, inputs, root, parentId) {
  const barrier = path.join(root, 'barrier');
  await fs.mkdir(barrier);
  const pending = inputs.map(input => runChild(config, input, barrier, parentId));
  for (let attempt = 0; attempt < 500; attempt++) {
    if ((await fs.readdir(barrier)).filter(name => name.startsWith('ready-')).length === inputs.length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await fs.readdir(barrier)).filter(name => name.startsWith('ready-')).length, inputs.length);
  await fs.writeFile(path.join(barrier, 'go'), 'go');
  return Promise.all(pending);
}

test('separate processes deduplicate an identical request ID under one slot', async () => {
  const { root, repo, config } = await fixture();
  const input = { repository: repo, title: 'same', prompt: 'same', request_id: 'idempotent' };
  const result = await parallel(config, [input, input], root);
  assert.deepEqual(result.map(item => item.ok), [true, true]);
  assert.equal(result[0].id, result[1].id);
  assert.equal((await fs.readdir(path.join(config.stateDir, 'jobs'))).length, 1);
});

test('separate processes reject conflicting request ID payloads', async () => {
  const { root, repo, config } = await fixture();
  const input = { repository: repo, title: 'same', prompt: 'one', request_id: 'conflict' };
  const result = await parallel(config, [input, { ...input, prompt: 'two' }], root);
  assert.equal(result.filter(item => item.ok).length, 1);
  assert.match(result.find(item => !item.ok).error, /request_id already used with different inputs/);
});

test('separate processes enforce global concurrency', async () => {
  const { root, repo, config } = await fixture();
  const input = { repository: repo, title: 'one', prompt: 'one' };
  const result = await parallel(config, [input, { ...input, title: 'two', prompt: 'two' }], root);
  assert.equal(result.filter(item => item.ok).length, 1);
  assert.match(result.find(item => !item.ok).error, /Concurrency limit reached/);
});

test('separate processes exclude sibling followups from one worktree', async () => {
  const { root, repo, config } = await fixture(2);
  const manager = await new Manager(config, { PATH: process.env.PATH, HOME: process.env.HOME }, { spawnWorker: false }).init();
  const parent = await manager.start({ repository: repo, title: 'parent', prompt: 'parent' });
  const privateParent = await manager.read(parent.id);
  const sessionFile = path.join(privateParent.sessionDir, 'session.jsonl');
  const sessionBytes = Buffer.from('{}\n');
  await fs.writeFile(sessionFile, sessionBytes);
  await atomicJson(path.join(manager.jobDir(parent.id), 'job.json'), { ...privateParent, status: 'completed', sessionFile,
    sessionCheckpoint: { complete: true, size: sessionBytes.length, sha256: createHash('sha256').update(sessionBytes).digest('hex') } });
  const result = await parallel(config, [{ prompt: 'one', request_id: 'follow-one' }, { prompt: 'two', request_id: 'follow-two' }], root, parent.id);
  assert.equal(result.filter(item => item.ok).length, 1);
  assert.match(result.find(item => !item.ok).error, /Worktree already active|not latest worktree tip/);
});

test('terminal parent with no recorded session can retry in its valid worktree', async () => {
  const { repo, config } = await fixture(2);
  const manager = await new Manager(config, { PATH: process.env.PATH, HOME: process.env.HOME }, { spawnWorker: false }).init();
  const parent = await manager.start({ repository: repo, title: 'parent', prompt: 'parent' });
  const privateParent = await manager.read(parent.id);
  await atomicJson(path.join(manager.jobDir(parent.id), 'job.json'), { ...privateParent, status: 'failed', finishedAt: new Date().toISOString() });
  const follow = await manager.start({ prompt: 'retry without a session' }, parent.id);
  assert.equal(follow.worktree, parent.worktree);
  assert.equal(follow.parentJobId, parent.id);
});

test('selected commit excludes tracked edits, untracked and ignored source files', async () => {
  const { root, repo, config, base, git } = await fixture();
  await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
  git('add', '.gitignore'); git('commit', '-qm', 'ignore');
  const selected = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'dirty\n');
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'untracked\n');
  await fs.writeFile(path.join(repo, 'ignored.txt'), 'ignored\n');
  const manager = await new Manager(config, { PATH: process.env.PATH, HOME: process.env.HOME }, { spawnWorker: false }).init();
  const job = await manager.start({ repository: repo, title: 'isolation', prompt: 'isolation', base_ref: selected });
  assert.equal(job.baseCommit, selected);
  assert.notEqual(job.baseCommit, base);
  assert.equal(await fs.readFile(path.join(job.worktree, 'tracked.txt'), 'utf8'), 'base\n');
  for (const name of ['untracked.txt', 'ignored.txt']) {
    assert.equal(await fs.stat(path.join(job.worktree, name)).then(() => true, () => false), false);
  }
  assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'dirty\n');
  assert.match(job.warning, /uncommitted changes/);
});
