import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Manager } from '../src/manager.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(scenario = 'success') {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-life-'));
  const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Only test files.'); git('add', '.'); git('commit', '-qm', 'base');
  const stateDir = path.join(tmp, 'state');
  await fs.chmod(fake, 0o755);
  const manager = await new Manager({ stateDir, allowedRoots: [tmp], maxConcurrent: 2, defaultTimeoutSeconds: 10, maxTimeoutSeconds: 60, defaultMaxTurns: 2,
    piPath: fake, allowedCommands: [] }, { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', FAKE_PI_SCENARIO: scenario }).init();
  const input = { repository, title: 'Lifecycle', prompt: 'Use fake Pi', provider: 'mock', model: 'mock' };
  return { manager, input };
}
async function finished(manager, id) {
  for (let i = 0; i < 100; i++) { const status = await manager.status(id); if (!['starting', 'running'].includes(status.status)) return status; await delay(100); }
  throw new Error('Job did not finish');
}

test('detached worker completes only after settlement and followup retains session', async () => {
  const { manager, input } = await setup();
  const first = await manager.start(input);
  await delay(120);
  assert.match((await manager.status(first.id)).status, /starting|running/);
  const done = await finished(manager, first.id);
  assert.equal(done.status, 'completed');
  assert.match((await manager.result(first.id)).result, /Fake Pi completed/);
  const follow = await manager.start({ prompt: 'Continue' }, first.id);
  assert.equal(follow.worktree, first.worktree);
  assert.equal((await finished(manager, follow.id)).status, 'completed');
  assert.equal((await manager.result(first.id)).status, 'completed');
});

test('provider error and cancellation are terminal failures', async () => {
  const failed = await setup('provider_error');
  const job = await failed.manager.start(failed.input);
  assert.equal((await finished(failed.manager, job.id)).status, 'failed');
  const hanging = await setup('hang');
  const wait = await hanging.manager.start(hanging.input);
  await delay(300);
  await hanging.manager.cancel(wait.id);
  assert.equal((await finished(hanging.manager, wait.id)).status, 'cancelled');
});

test('worker death quarantines uncertain Pi group and retains capacity', async () => {
  const { manager, input } = await setup('hang');
  manager.config.maxConcurrent = 1;
  const start = await manager.start(input);
  let privateJob;
  for (let i = 0; i < 50; i++) {
    privateJob = await manager.read(start.id);
    if (privateJob.piPid) break;
    await delay(100);
  }
  assert.ok(privateJob.piPid);
  process.kill(privateJob.workerPid, 'SIGKILL');
  try {
    let status;
    for (let i = 0; i < 50; i++) {
      status = await manager.status(start.id);
      if (status.status === 'quarantined') break;
      await delay(100);
    }
    assert.equal(status.status, 'quarantined');
    await assert.rejects(manager.start({ ...input, request_id: 'next' }), /Concurrency limit|Worktree already active/);
  } finally {
    try { process.kill(-privateJob.piPid, 'SIGKILL'); } catch {}
  }
});

test('stale status observer never overwrites a final worker snapshot', async () => {
  const { manager, input } = await setup();
  const start = await manager.start(input);
  const stale = await manager.read(start.id);
  const done = await finished(manager, start.id);
  assert.equal(done.status, 'completed');
  const recovered = await manager.recover(stale);
  assert.equal(recovered.status, 'completed');
  assert.equal((await manager.read(start.id)).status, 'completed');
});
