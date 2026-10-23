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
  for (let i = 0; i < 150; i++) { const status = await manager.status(id); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) return status; await delay(100); }
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

test('protocol error cannot release a still-writing Pi process', async () => {
  const { manager, input } = await setup();
  manager.config.maxConcurrent = 1;
  const start = await manager.start({ ...input, prompt: '[FAKE_PROTOCOL_ERROR_WRITER]' });
  let privateJob;
  try {
    const status = await finished(manager, start.id);
    privateJob = await manager.read(start.id);
    const marker = path.join(start.worktree, 'writer.txt');
    const before = await fs.readFile(marker, 'utf8');
    await delay(400);
    const after = await fs.readFile(marker, 'utf8');
    assert.equal(after, before, `writer continued after terminal ${status.status}`);
    assert.ok(['failed', 'quarantined'].includes(status.status));
  } finally {
    privateJob ||= await manager.read(start.id);
    if (privateJob.piPid) try { process.kill(-privateJob.piPid, 'SIGKILL'); } catch {}
  }
});

test('uncaught RPC listener failure cleans up child before releasing slot', async () => {
  const { manager, input } = await setup();
  manager.config.maxConcurrent = 1;
  const started = await manager.start({ ...input, prompt: '[FAKE_THROW_WRITER]' });
  let privateJob;
  try {
    const status = await finished(manager, started.id);
    privateJob = await manager.read(started.id);
    const marker = path.join(started.worktree, 'writer.txt');
    const before = await fs.readFile(marker, 'utf8');
    await delay(400);
    assert.equal(await fs.readFile(marker, 'utf8'), before);
    assert.ok(['failed', 'quarantined'].includes(status.status));
  } finally {
    privateJob ||= await manager.read(started.id);
    if (privateJob.piPid) try { process.kill(-privateJob.piPid, 'SIGKILL'); } catch {}
  }
});

test('worker records observed model and rejects an unobserved selection', async () => {
  const good = await setup();
  const started = await good.manager.start(good.input);
  assert.equal((await finished(good.manager, started.id)).effectiveModel, 'mock/mock');
  const bad = await setup('wrong_model');
  const wrong = await bad.manager.start(bad.input);
  assert.equal((await finished(bad.manager, wrong.id)).status, 'failed');
});

test('followup starts a fresh session only when parent never recorded one', async () => {
  const { manager, input } = await setup();
  const first = await manager.start(input);
  assert.equal((await finished(manager, first.id)).status, 'completed');
  const privateJob = await manager.read(first.id);
  delete privateJob.sessionFile;
  await fs.writeFile(path.join(manager.jobDir(first.id), 'job.json'), JSON.stringify(privateJob));
  const next = await manager.start({ prompt: 'Continue without recorded session' }, first.id);
  assert.equal(next.worktree, first.worktree);
  assert.equal((await finished(manager, next.id)).status, 'completed');
  const nextPrivate = await manager.read(next.id);
  assert.equal(nextPrivate.sessionDir, privateJob.sessionDir);
  assert.ok(nextPrivate.sessionFile);
  const tampered = await manager.read(next.id);
  tampered.sessionFile = path.join(tampered.sessionDir, 'missing.jsonl');
  await fs.writeFile(path.join(manager.jobDir(next.id), 'job.json'), JSON.stringify(tampered));
  await assert.rejects(manager.start({ prompt: 'Tampered session' }, next.id), /Parent session unavailable/);
});

test('recovered provider retry clears prior error', async () => {
  const { manager, input } = await setup('retry_success');
  const started = await manager.start(input);
  assert.equal((await finished(manager, started.id)).status, 'completed');
});

test('model env reference secret is absent from public and private result', async () => {
  const { manager, input } = await setup('secret_echo');
  const secret = 'company-private-credential';
  manager.childEnv.CORP_SESSION = secret;
  const modelsFile = path.join(path.dirname(manager.config.stateDir), 'models.json');
  await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: { apiKey: '$CORP_SESSION' } } }));
  manager.config.modelsFile = modelsFile;
  const started = await manager.start(input);
  assert.equal((await finished(manager, started.id)).status, 'completed');
  const result = await manager.result(started.id);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const privateResult = await fs.readFile(path.join(manager.jobDir(started.id), 'result.txt'), 'utf8');
  assert.equal(privateResult.includes(secret), false);
});

test('braced and embedded model env references redact result and status', async () => {
  const secret = 'company-private-credential';
  for (const reference of ['${CORP_SESSION}', 'prefix-${CORP_SESSION}']) {
    const { manager, input } = await setup('secret_error');
    manager.childEnv.CORP_SESSION = secret;
    const modelsFile = path.join(path.dirname(manager.config.stateDir), 'models.json');
    await fs.writeFile(modelsFile, JSON.stringify({ providers: { mock: { apiKey: reference, headers: { Authorization: reference } } } }));
    manager.config.modelsFile = modelsFile;
    const started = await manager.start(input);
    const status = await finished(manager, started.id);
    assert.equal(status.status, 'failed');
    assert.equal(JSON.stringify(status).includes(secret), false, reference);
    const result = await manager.result(started.id);
    assert.equal(JSON.stringify(result).includes(secret), false, reference);
    const privateResult = await fs.readFile(path.join(manager.jobDir(started.id), 'result.txt'), 'utf8');
    assert.equal(privateResult.includes(secret), false, reference);
  }
});

test('startup deadline remains timed_out when policy readiness never arrives', { timeout: 20000 }, async () => {
  const { manager, input } = await setup('never_ready');
  const started = await manager.start(input);
  const done = await finished(manager, started.id);
  assert.equal(done.status, 'timed_out');
});
