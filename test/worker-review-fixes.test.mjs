import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Manager } from '../src/manager.mjs';

// Regression coverage for two confirmed review defects in src/worker.mjs:
//  1. stop() fired `abort` without awaiting it and immediately SIGTERMed
//     Pi's process group, racing Pi's own graceful shutdown.
//  2. If Pi exited before `processIdentity(child.pid)` could read its /proc
//     identity, the job was quarantined forever instead of failing normally.

const gracefulPi = fileURLToPath(new URL('./fixtures/graceful-stop-pi.mjs', import.meta.url));
const instantExitPi = fileURLToPath(new URL('./fixtures/instant-exit-pi.sh', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(piPath, extraEnv = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-worker-fixes-'));
  const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Only test files.'); git('add', '.'); git('commit', '-qm', 'base');
  const stateDir = path.join(tmp, 'state');
  await fs.chmod(piPath, 0o755);
  const manager = await new Manager({ stateDir, allowedRoots: [tmp], maxConcurrent: 2, defaultTimeoutSeconds: 10, maxTimeoutSeconds: 60, defaultMaxTurns: 2,
    piPath, allowedCommands: [] }, { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...extraEnv }).init();
  const input = { repository, title: 'WorkerFixes', prompt: 'Use fake Pi', provider: 'mock', model: 'mock' };
  return { manager, input, tmp };
}
async function finished(manager, id) {
  for (let i = 0; i < 150; i++) { const status = await manager.status(id); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) return status; await delay(100); }
  throw new Error('Job did not finish');
}
async function waitForFirstTurn(manager, id) {
  for (let i = 0; i < 100; i++) { const status = await manager.status(id); if ((status.numTurns || 0) >= 1) return status; await delay(50); }
  throw new Error('Pi never started a turn');
}

test('cancel lets a graceful Pi finish writing its own abort state before its process group is signalled', { timeout: 20000 }, async () => {
  const { manager, input } = await setup(gracefulPi, { FAKE_PI_SCENARIO: 'slow_exit' });
  const start = await manager.start(input);
  await waitForFirstTurn(manager, start.id);
  await manager.cancel(start.id);
  const done = await finished(manager, start.id);
  assert.equal(done.status, 'cancelled');
  const marker = await fs.readFile(path.join(start.worktree, 'graceful-abort.marker'), 'utf8');
  assert.equal(marker, 'aborted-before-exit');
});

test('cancel still stays bounded and reaps the process group when Pi never answers abort', { timeout: 20000 }, async () => {
  const { manager, input } = await setup(gracefulPi, { FAKE_PI_SCENARIO: 'ignore_abort' });
  const start = await manager.start(input);
  await waitForFirstTurn(manager, start.id);
  const before = Date.now();
  await manager.cancel(start.id);
  const done = await finished(manager, start.id);
  const elapsed = Date.now() - before;
  assert.equal(done.status, 'cancelled');
  assert.ok(elapsed < 10000, `cancel took too long to settle: ${elapsed}ms`);
  const privateJob = await manager.read(start.id);
  let processState = '';
  try { processState = execFileSync('ps', ['-o', 'stat=', '-p', String(privateJob.piPid)], { encoding: 'utf8' }).trim(); }
  catch {}
  assert.ok(!processState || processState.startsWith('Z'), `Pi process still alive: ${processState}`);
});

test('Pi exiting before its process identity can be read fails the job instead of quarantining it forever', { timeout: 60000 }, async () => {
  let observed;
  for (let attempt = 0; attempt < 25 && !observed; attempt++) {
    const { manager, input } = await setup(instantExitPi);
    const start = await manager.start(input);
    const done = await finished(manager, start.id);
    const privateJob = await manager.read(start.id);
    assert.notEqual(done.status, 'quarantined',
      `job quarantined on attempt ${attempt} (piPid=${privateJob.piPid}, piIdentity=${JSON.stringify(privateJob.piIdentity)}, piExitedBeforeIdentity=${privateJob.piExitedBeforeIdentity})`);
    if (privateJob.piExitedBeforeIdentity) observed = { done, privateJob };
  }
  assert.ok(observed, 'never observed Pi exiting before its identity could be read after 25 attempts');
  assert.equal(observed.done.status, 'failed');
  assert.match(observed.done.error || '', /Pi exited during startup/);
  assert.equal(observed.privateJob.piPid, null);
});
