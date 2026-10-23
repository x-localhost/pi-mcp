import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Manager } from '../src/manager.mjs';
import { validateConfig, loadConfig, buildChildEnv } from '../src/config.mjs';
import { processIdentity, groupState, stopOwnedGroup } from '../src/ownership.mjs';
import { normalizeImages, modelSupportsImages } from '../src/images.mjs';
import { runVerifier, evaluateVerification, reconcileFinalSnapshot } from '../src/verification.mjs';
import { scanState } from '../src/storage.mjs';
import { atomicJson } from '../src/manager.mjs';

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const config = { stateDir: path.join(root, 'state'), allowedRoots: [root], maxConcurrent: 1, defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60,
    defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [], provider: 'mock', model: 'mock',
    queue: { maxPending: 2, maxWaitSeconds: 30, dispatchIntervalMs: 100 }, ...overrides };
  const manager = await new Manager(config, { PATH: process.env.PATH }, { spawnWorker: false }).init();
  return { root, repository, git, config, manager };
}

test('config validates bounded queue, verification, budgets and retention', () => {
  const base = { piPath: '/bin/true', stateDir: '/tmp/pi-state', allowedRoots: ['/tmp'], provider: 'mock', model: 'mock' };
  const config = validateConfig({ ...base, queue: { maxPending: 2, maxWaitSeconds: 30, dispatchIntervalMs: 100 },
    verification: { commands: [{ id: 'unit', argv: ['/usr/bin/true'], timeoutSeconds: 3, maxOutputBytes: 1024 }] },
    budgets: { maxTotalTokens: 100 }, retention: { maxStateBytes: 1048576, maxScanEntries: 1000, terminalDays: 7 },
    artifacts: { maxFiles: 10 }, offlineMaterials: { materials: [] } }, '/tmp');
  assert.equal(config.queue.maxPending, 2);
  assert.equal(config.verification.commands[0].id, 'unit');
  assert.equal(config.budgets.maxTotalTokens, 100);
  assert.throws(() => validateConfig({ ...base, queue: { maxPending: 0 } }, '/tmp'), /queue/i);
  assert.throws(() => validateConfig({ ...base, verification: { commands: [{ id: 'bad', argv: ['sh', '-c', 'true'] }] } }, '/tmp'), /verification/i);
  assert.throws(() => validateConfig({ ...base, verification: { commands: [{ id: 'escape', argv: ['/usr/bin/../../tmp/executable'] }] } }, '/tmp'), /verification/i);
  assert.throws(() => validateConfig({ ...base, approvedMcp: { servers: [], surprise: true } }, '/tmp'), /approved MCP/i);
  for (const section of ['queue', 'verification', 'budgets', 'retention', 'artifacts', 'offlineMaterials', 'approvedMcp']) {
    assert.throws(() => validateConfig({ ...base, [section]: null }, '/tmp'), /invalid|must|config|MCP/i, section);
  }
  assert.throws(() => validateConfig({ ...base, queue: { maxPending: null } }, '/tmp'), /queue.maxPending/i);
  assert.throws(() => validateConfig({ ...base, verification: { commands: null } }, '/tmp'), /verification.commands/i);
});

test('bounded FIFO queue freezes base and selections and queued cancellation does not spawn', async t => {
  const { repository, git, manager } = await fixture(t);
  const first = await manager.start({ repository, title: 'first', prompt: 'one', request_id: 'first' });
  const second = await manager.start({ repository, title: 'second', prompt: 'two', request_id: 'second' });
  assert.equal(first.status, 'queued'); assert.equal(second.status, 'queued');
  assert.equal((await manager.read(second.id)).baseCommit, git('rev-parse', 'HEAD'));
  assert.equal((await manager.start({ repository, title: 'second', prompt: 'two', request_id: 'second' })).id, second.id);
  await assert.rejects(manager.start({ repository, title: 'third', prompt: 'three' }), /queue.*full/i);
  const cancelled = await manager.cancel(second.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellationRequested, true);
  assert.equal(await fs.access(path.join(manager.jobDir(second.id), 'worker.pid')).then(() => true, () => false), false);
  assert.equal((await manager.read(first.id)).status, 'queued');
});

test('cancel rechecks the admission race under the shared lock and signals the admitted worker', async t => {
  const { repository, manager } = await fixture(t);
  const started = await manager.start({ repository, title: 'Race cancel', prompt: 'run' });
  const job = await manager.read(started.id); job.status = 'starting'; job.admittedAt = new Date().toISOString();
  await atomicJson(path.join(manager.jobDir(started.id), 'job.json'), job);
  const cancelled = await manager.cancel(started.id);
  assert.equal(cancelled.cancellationRequested, true);
  assert.equal(await fs.readFile(path.join(manager.jobDir(started.id), 'cancel'), 'utf8').then(Boolean), true);
});

test('event cursors expose bounded replay and gaps', async t => {
  const { repository, manager } = await fixture(t);
  const started = await manager.start({ repository, title: 'events', prompt: 'run' });
  for (let i = 0; i < 6; i++) await manager.appendEvent(started.id, { type: 'progress', message: `message-${i}` });
  const events = await manager.events(started.id, { cursor: 0, limit: 2 });
  assert.equal(events.events.length, 2);
  assert.ok(events.nextCursor > 0);
});

test('recovery never treats stale identity, namespace mismatch, missing proc, or leader death with surviving group as stopped', async () => {
  const identity = await processIdentity();
  assert.equal((await groupState({ ...identity, startTicks: String(BigInt(identity.startTicks) + 1n) })).state, 'ambiguous');
  assert.equal((await groupState({ ...identity, pidNamespace: 'pid:[999999999]' })).state, 'ambiguous');
  assert.equal((await groupState(identity, { procRoot: '/no-such-proc-root' })).state, 'ambiguous');
  assert.equal((await groupState({ ...identity, pid: 999999999 })).state, 'ambiguous');
  assert.equal((await groupState({ ...identity, bootId: undefined })).state, 'ambiguous');
});

test('process-group scan ignores unrelated namespace denial but quarantines an unreadable candidate', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = await processIdentity();
  await fs.mkdir(path.join(root, 'sys/kernel/random'), { recursive: true });
  await fs.writeFile(path.join(root, 'sys/kernel/random/boot_id'), identity.bootId);
  await fs.mkdir(path.join(root, String(process.pid), 'ns'), { recursive: true });
  await fs.writeFile(path.join(root, String(process.pid), 'stat'), await fs.readFile(`/proc/${process.pid}/stat`));
  await fs.symlink(identity.pidNamespace, path.join(root, String(process.pid), 'ns/pid'));
  const other = path.join(root, '888888'); await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'stat'), '888888 (other) S 1 999999 999999 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n');
  assert.equal((await groupState(identity, { procRoot: root })).state, 'owned');
  await fs.writeFile(path.join(other, 'stat'), `888888 (candidate) S 1 ${identity.pgid} ${identity.pgid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`);
  assert.equal((await groupState(identity, { procRoot: root })).state, 'ambiguous');
});

test('queue admission rejects changed administrator policy without creating a worktree', async t => {
  const { repository, manager, config } = await fixture(t);
  const started = await manager.start({ repository, title: 'policy', prompt: 'run' });
  config.allowedCommands = ['changed'];
  await manager.dispatchOnce();
  const result = await manager.read(started.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /policy changed/i);
  assert.equal(await fs.stat(result.worktree).then(() => true, () => false), false);
});

test('queued admission pins executable and roots but permits validated owned credential refresh', async t => {
  const changed = await fixture(t);
  const first = await changed.manager.start({ repository: changed.repository, title: 'Pinned', prompt: 'run' });
  changed.config.piPath = '/usr/bin/false';
  await changed.manager.dispatchOnce();
  assert.match((await changed.manager.read(first.id)).error, /policy changed/i);
  assert.equal(await fs.stat((await changed.manager.read(first.id)).worktree).then(() => true, () => false), false);
  const rotated = await fixture(t);
  await fs.writeFile(path.join(rotated.manager.agentDir, 'auth.json'), JSON.stringify({ token: 'first' }));
  const queued = await rotated.manager.start({ repository: rotated.repository, title: 'Rotating auth', prompt: 'run' });
  await fs.writeFile(path.join(rotated.manager.agentDir, 'auth.json'), JSON.stringify({ token: 'second' }));
  await rotated.manager.dispatchOnce();
  assert.equal((await rotated.manager.read(queued.id)).status, 'starting');
});

test('queued admission rechecks storage after submission before creating a worktree', async t => {
  const { repository, manager } = await fixture(t, { retention: { maxStateBytes: 1048576, maxScanEntries: 1000, terminalDays: 7 } });
  const first = await manager.start({ repository, title: 'Full later', prompt: 'run' });
  await fs.writeFile(path.join(manager.config.stateDir, 'late-large.bin'), Buffer.alloc(1048576));
  await manager.dispatchOnce();
  const denied = await manager.read(first.id);
  assert.equal(denied.status, 'failed');
  assert.match(denied.error, /storage admission limit/i);
  assert.equal(await fs.stat(denied.worktree).then(() => true, () => false), false);
});

test('queued work expires without spawning and a cleaned request ID remains reserved', async t => {
  const { repository, manager } = await fixture(t);
  const first = await manager.start({ repository, title: 'Expire', prompt: 'run', request_id: 'expire-1' });
  const job = await manager.read(first.id);
  job.queueExpiresAt = new Date(Date.now() - 1000).toISOString();
  await atomicJson(path.join(manager.jobDir(first.id), 'job.json'), job);
  await manager.dispatchOnce();
  const expired = await manager.read(first.id);
  assert.equal(expired.status, 'queue_expired');
  assert.equal(await fs.stat(expired.worktree).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(manager.jobDir(first.id), 'worker.pid')).then(() => true, () => false), false);
  const preview = await manager.cleanup();
  assert.deepEqual(preview.candidates, []);
  await manager.cleanup({ job_ids: [first.id], dry_run: false });
  await assert.rejects(manager.start({ repository, title: 'Expire', prompt: 'run', request_id: 'expire-1' }), /request_id belongs to a prior cleaned/i);
});

test('default cleanup previews administrator retention age but deletion needs an explicit selection', async t => {
  const { repository, manager } = await fixture(t, { retention: { maxStateBytes: 1048576, maxScanEntries: 1000, terminalDays: 7 } });
  const first = await manager.start({ repository, title: 'Old', prompt: 'run' });
  const job = await manager.read(first.id); job.status = 'cancelled'; job.finishedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  await atomicJson(path.join(manager.jobDir(first.id), 'job.json'), job);
  assert.deepEqual((await manager.cleanup()).candidates, [first.id]);
  await assert.rejects(manager.cleanup({ dry_run: false }), /explicit cleanup selection/i);
  assert.equal((await manager.read(first.id)).status, 'cancelled');
});

test('storage scan stops during enumeration and admission rejects a full state directory', async t => {
  const { repository, manager } = await fixture(t, { retention: { maxStateBytes: 1048576, maxScanEntries: 5, terminalDays: 7 } });
  const many = path.join(manager.config.stateDir, 'many'); await fs.mkdir(many);
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(many, String(i)), 'x');
  await assert.rejects(scanState(manager.config.stateDir, manager.config.retention), /scan bound/i);
  await fs.rm(many, { recursive: true });
  manager.config.retention.maxScanEntries = 100;
  await fs.writeFile(path.join(manager.config.stateDir, 'large.bin'), Buffer.alloc(1048576));
  await assert.rejects(manager.start({ repository, title: 'No capacity', prompt: 'run' }), /storage admission limit/i);
  assert.equal((await manager.all()).length, 0);
});

test('storage scan tolerates only entries proven to disappear during bounded traversal', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-scan-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vanishedFile = path.join(root, 'temporary.json');
  const vanishedDir = path.join(root, 'temporary-dir');
  await fs.writeFile(vanishedFile, '{}');
  await fs.mkdir(vanishedDir);
  const originalLstat = fs.lstat, originalOpendir = fs.opendir;
  try {
    fs.lstat = async file => {
      if (file === vanishedFile) await fs.rm(file);
      return originalLstat(file);
    };
    fs.opendir = async file => {
      if (file === vanishedDir) await fs.rmdir(file);
      return originalOpendir(file);
    };
    const observed = await scanState(root, { maxScanEntries: 4 });
    assert.equal(observed.withinLimit, true);
    assert.equal(observed.entries, 3);
    fs.lstat = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    await assert.rejects(scanState(root), /denied/);
  } finally {
    fs.lstat = originalLstat;
    fs.opendir = originalOpendir;
  }
});

test('recoverJob inspects, safely stops a proven group, and leaves ambiguous ownership quarantined', { timeout: 15000 }, async t => {
  const { repository, manager } = await fixture(t);
  const child = spawn('/usr/bin/sleep', ['20'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const identity = await processIdentity(child.pid);
  t.after(async () => { await stopOwnedGroup(identity, 10).catch(() => {}); });
  const first = await manager.start({ repository, title: 'Recover', prompt: 'run' });
  const job = await manager.read(first.id); job.status = 'quarantined'; job.workerIdentity = identity;
  await atomicJson(path.join(manager.jobDir(first.id), 'job.json'), job);
  const inspected = await manager.recoverJob(first.id);
  assert.equal(inspected.evidence.worker.state, 'owned');
  assert.equal((await manager.read(first.id)).status, 'quarantined');
  const recovered = await manager.recoverJob(first.id, { terminate: true });
  assert.equal(recovered.status, 'interrupted', JSON.stringify(recovered));
  assert.equal((await groupState(identity)).state, 'stopped');
  const second = await manager.start({ repository, title: 'Ambiguous', prompt: 'run' });
  const other = await manager.read(second.id); other.status = 'quarantined'; other.workerIdentity = { ...await processIdentity(), startTicks: String(BigInt((await processIdentity()).startTicks) + 1n) };
  await atomicJson(path.join(manager.jobDir(second.id), 'job.json'), other);
  const held = await manager.recoverJob(second.id, { terminate: true });
  assert.equal(held.status, 'quarantined');
  assert.equal((await manager.read(second.id)).status, 'quarantined');
});

test('inline images require exact supported magic, canonical base64 and a bounded aggregate', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex').toString('base64');
  assert.equal(normalizeImages([{ mimeType: 'image/png', data: png }])[0].type, 'image');
  assert.throws(() => normalizeImages([{ mimeType: 'image/png', data: 'https://example.invalid/x' }]), /image/i);
  assert.throws(() => normalizeImages([{ mimeType: 'image/jpeg', data: png }]), /image/i);
  assert.throws(() => normalizeImages([{ mimeType: 'image/png', data: png + 'AAAA' }]), /image/i);
  assert.throws(() => normalizeImages([{ mimeType: 'image/png', data: Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(1024 * 1024)]).toString('base64') }]), /image/i);
  assert.equal(modelSupportsImages({ input: ['text', 'image'] }), true);
  assert.equal(modelSupportsImages({ input: ['text'] }), false);
});

test('administrator verifier captures exit and omits overflow output in full', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-verify-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ok = await runVerifier({ id: 'ok', argv: ['/usr/bin/printf', 'verified'], timeoutSeconds: 2, maxOutputBytes: 16 },
    { cwd: root, env: { PATH: process.env.PATH }, sanitize: text => text });
  assert.equal(ok.status, 'passed', JSON.stringify(ok)); assert.equal(ok.stdout, 'verified');
  const overflow = await runVerifier({ id: 'overflow', argv: ['/usr/bin/printf', 'credential_secret'], timeoutSeconds: 2, maxOutputBytes: 4 },
    { cwd: root, env: { PATH: process.env.PATH }, sanitize: text => text });
  assert.equal(overflow.truncated, true); assert.equal(overflow.stdout, ''); assert.equal(overflow.stderr, '');
});

test('failed verifier stays failed and an injected incomplete or changed final capture downgrades only passed verification', () => {
  const baseline = { checkpointComplete: true, inputSnapshotDigest: 'source-a' };
  const failed = evaluateVerification(baseline, baseline, [{ id: 'lint', status: 'failed' }], 1);
  assert.equal(failed.status, 'failed');
  assert.equal(reconcileFinalSnapshot(failed, { checkpointComplete: false, inputSnapshotDigest: 'source-b' }).status, 'failed');
  const timedOut = evaluateVerification(baseline, baseline, [{ id: 'lint', status: 'timed_out' }], 1);
  assert.equal(timedOut.status, 'timed_out');
  const passed = evaluateVerification(baseline, baseline, [{ id: 'lint', status: 'passed' }], 1);
  assert.equal(passed.status, 'passed');
  assert.equal(reconcileFinalSnapshot(passed, { checkpointComplete: false, inputSnapshotDigest: 'source-a' }).status, 'mutated_or_incomplete');
  assert.equal(reconcileFinalSnapshot(passed, { checkpointComplete: true, inputSnapshotDigest: 'source-b' }).status, 'mutated_or_incomplete');
  assert.equal(reconcileFinalSnapshot(passed, baseline).status, 'passed');
});

async function queuedPiFixture(t, commands = [], extra = {}, sourceEnv = process.env) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-queued-flow-'));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const fake = new URL('./fixtures/fake-pi.mjs', import.meta.url).pathname;
  const configFile = path.join(root, 'config.json');
  t.after(async () => { await fs.rm(configFile, { force: true }); await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  await fs.writeFile(configFile, JSON.stringify({ piPath: process.execPath, piArgs: [fake], stateDir: path.join(root, 'state'), allowedRoots: [root],
    maxConcurrent: 1, provider: 'mock', model: 'mock', queue: { maxPending: 3, maxWaitSeconds: 30, dispatchIntervalMs: 100 },
    verification: { commands }, defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, defaultMaxTurns: 2, ...extra }));
  const config = await loadConfig(configFile);
  const manager = await new Manager(config, buildChildEnv(config, sourceEnv)).init();
  return { root, repository, manager };
}
test('detached dispatcher retains only a configured named proxy selector and admits the job', { timeout: 15000 }, async t => {
  const { repository, manager } = await queuedPiFixture(t, [], { network: { httpsProxyEnv: 'CORP_PROXY' } },
    { ...process.env, CORP_PROXY: 'http://127.0.0.1:9' });
  const first = await manager.start({ repository, title: 'Proxy selector', prompt: 'run' });
  assert.equal((await waitJob(manager, first.id, job => job.status === 'completed')).status, 'completed');
});
async function waitJob(manager, id, predicate, limit = 200) {
  for (let i = 0; i < limit; i++) { const job = await manager.read(id); if (predicate(job)) return job; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Job state not reached');
}

test('verifier keeps job nonterminal and exported report matches final verified snapshot', { timeout: 30000 }, async t => {
  const { repository, manager } = await queuedPiFixture(t, [{ id: 'slow', argv: ['/usr/bin/sleep', '2'], timeoutSeconds: 5, maxOutputBytes: 1000 }]);
  const first = await manager.start({ repository, title: 'Verify', prompt: 'run', verification_ids: ['slow'] });
  const during = await waitJob(manager, first.id, job => job.verifierIdentities?.length > 0);
  assert.equal(during.status, 'finalizing');
  await assert.rejects(manager.start({ prompt: 'follow' }, first.id), /not terminal/i);
  const done = await waitJob(manager, first.id, job => job.status === 'completed');
  assert.equal(done.verification.status, 'passed', JSON.stringify(done.verification));
  const page = await manager.artifacts(first.id);
  const entry = page.entries.find(item => item.path === 'reports/verification');
  assert.ok(entry);
  const payload = await manager.readArtifact(first.id, { artifact_id: entry.id, offset: 0, length: 65536 });
  const report = JSON.parse(Buffer.from(payload.data_base64, 'base64').toString());
  assert.equal(report.status, done.verification.status);
  assert.equal(report.verifiedSnapshotDigest, page.inputSnapshotDigest);
  const stateAtTerminal = await fs.readFile(path.join(manager.jobDir(first.id), 'job.json'));
  const eventsAtTerminal = await fs.readFile(path.join(manager.jobDir(first.id), 'events.json'));
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(await fs.readFile(path.join(manager.jobDir(first.id), 'job.json')), stateAtTerminal);
  assert.deepEqual(await fs.readFile(path.join(manager.jobDir(first.id), 'events.json')), eventsAtTerminal);
});

test('cancel during verifier stops its owned group and leaves separate verification result', { timeout: 30000 }, async t => {
  const { repository, manager } = await queuedPiFixture(t, [{ id: 'slow', argv: ['/usr/bin/sleep', '5'], timeoutSeconds: 8, maxOutputBytes: 1000 }]);
  const first = await manager.start({ repository, title: 'Cancel verify', prompt: 'run', verification_ids: ['slow'] });
  await waitJob(manager, first.id, job => job.verifierIdentities?.length > 0);
  await manager.cancel(first.id);
  const done = await waitJob(manager, first.id, job => ['cancelled', 'quarantined'].includes(job.status));
  assert.equal(done.status, 'cancelled', JSON.stringify(done));
  assert.equal(done.execution.status, 'passed');
  assert.equal(done.verification.commands[0].status, 'cancelled');
});

test('fork after followup uses immutable original code and session checkpoints', { timeout: 30000 }, async t => {
  const { repository, manager } = await queuedPiFixture(t);
  const first = await manager.start({ repository, title: 'Origin', prompt: 'run' });
  const origin = await waitJob(manager, first.id, job => job.status === 'completed');
  assert.equal(origin.artifacts.checkpointComplete, true);
  assert.equal(origin.sessionCheckpoint.complete, true);
  await fs.writeFile(path.join(origin.worktree, 'later.txt'), 'later followup change\n');
  const follow = await manager.start({ prompt: 'continue' }, first.id);
  await waitJob(manager, follow.id, job => job.status === 'completed');
  const forked = await manager.fork(first.id, { prompt: 'branch from original', request_id: 'fork-original' });
  const child = await waitJob(manager, forked.id, job => job.status === 'completed');
  assert.notEqual(child.worktree, origin.worktree);
  assert.notEqual(child.sessionDir, origin.sessionDir);
  assert.equal(await fs.stat(path.join(child.worktree, 'later.txt')).then(() => true, () => false), false);
  assert.equal(child.inputSnapshotDigest, origin.artifacts.inputSnapshotDigest);
  const originalSession = await fs.readFile(path.join(manager.jobDir(first.id), 'private-session', 'session.jsonl'), 'utf8');
  assert.ok((await fs.readFile(child.sessionFile, 'utf8')).startsWith(originalSession));
});

test('steer reports worker acknowledgement and public events contain no prompt text', { timeout: 20000 }, async t => {
  const { repository, manager } = await queuedPiFixture(t);
  const started = await manager.start({ repository, title: 'Steer', prompt: '[FAKE_HANG]' });
  await waitJob(manager, started.id, job => job.status === 'running' && !!job.sessionFile);
  const ack = await manager.steer(started.id, { message: 'private steering payload' });
  assert.equal(ack.status, 'queued_by_pi', JSON.stringify(ack));
  const events = await manager.events(started.id);
  assert.equal(JSON.stringify(events).includes('private steering payload'), false);
  await manager.cancel(started.id);
  assert.equal((await waitJob(manager, started.id, job => job.status === 'cancelled')).status, 'cancelled');
});

test('inline steer image reaches Pi queue without retaining processed raw payload', { timeout: 20000 }, async t => {
  const { repository, manager } = await queuedPiFixture(t, [], { envAllowlist: ['FAKE_PI_IMAGE_SUPPORT'] });
  manager.childEnv.FAKE_PI_IMAGE_SUPPORT = '1';
  const started = await manager.start({ repository, title: 'Image steer', prompt: '[FAKE_HANG]' });
  await waitJob(manager, started.id, job => job.status === 'running' && job.modelInputImageSupported === true);
  const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex').toString('base64');
  const ack = await manager.steer(started.id, { message: 'image steer', images: [{ mimeType: 'image/png', data: png }] });
  assert.equal(ack.status, 'queued_by_pi', JSON.stringify(ack));
  const names = await fs.readdir(path.join(manager.jobDir(started.id), 'controls'));
  assert.equal(names.some(name => name.startsWith('processing-')), false);
  assert.equal(JSON.stringify(await manager.events(started.id)).includes(png), false);
  await manager.cancel(started.id);
  await waitJob(manager, started.id, job => job.status === 'cancelled');
});

test('inline image support is observed and token/cost budgets fail clearly', { timeout: 30000 }, async t => {
  const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex').toString('base64');
  const withImage = await queuedPiFixture(t, [], { envAllowlist: ['FAKE_PI_IMAGE_SUPPORT'] });
  withImage.manager.childEnv.FAKE_PI_IMAGE_SUPPORT = '1';
  const imageJob = await withImage.manager.start({ repository: withImage.repository, title: 'Image', prompt: 'see image', images: [{ mimeType: 'image/png', data: png }] });
  const imageDone = await waitJob(withImage.manager, imageJob.id, job => job.status === 'completed');
  assert.match((await withImage.manager.result(imageDone.id)).result, /with 1 images/);
  const budget = await queuedPiFixture(t, [], { budgets: { maxTotalTokens: 5 } });
  const limited = await budget.manager.start({ repository: budget.repository, title: 'Budget', prompt: '[FAKE_BUDGET]' });
  const exhausted = await waitJob(budget.manager, limited.id, job => job.status === 'budget_limit');
  assert.equal(exhausted.budget.status, 'observed_limit');
  const cost = await queuedPiFixture(t, [], { budgets: { maxCostUsd: 1 } });
  const unknown = await cost.manager.start({ repository: cost.repository, title: 'Cost', prompt: 'run' });
  const failed = await waitJob(cost.manager, unknown.id, job => job.status === 'failed');
  assert.match(failed.error, /Cost budget unenforceable/i);
  const statsOnly = await queuedPiFixture(t, [], { budgets: { maxTotalTokens: 5 } });
  const statsJob = await statsOnly.manager.start({ repository: statsOnly.repository, title: 'Stats only', prompt: '[FAKE_STATS_ONLY]' });
  const statsDone = await waitJob(statsOnly.manager, statsJob.id, job => job.status === 'budget_limit');
  assert.equal(statsDone.usage.input, 20);
  const missing = await queuedPiFixture(t, [], { budgets: { maxTotalTokens: 5 } });
  const missingJob = await missing.manager.start({ repository: missing.repository, title: 'No usage', prompt: '[FAKE_NO_USAGE]' });
  const missingDone = await waitJob(missing.manager, missingJob.id, job => job.status === 'budget_unavailable');
  assert.equal(missingDone.budget.status, 'unavailable');
  const negative = await queuedPiFixture(t, [], { budgets: { maxTotalTokens: 5 } });
  const negativeJob = await negative.manager.start({ repository: negative.repository, title: 'Negative usage', prompt: '[FAKE_NEGATIVE_USAGE]' });
  const negativeDone = await waitJob(negative.manager, negativeJob.id, job => job.status === 'budget_unavailable');
  assert.equal(negativeDone.budget.status, 'unavailable');
  assert.equal(negativeDone.usage?.input, undefined);
  const total = await queuedPiFixture(t, [], { budgets: { maxTotalTokens: 5 } });
  const totalJob = await total.manager.start({ repository: total.repository, title: 'Total only', prompt: '[FAKE_TOTAL_ONLY]' });
  const totalDone = await waitJob(total.manager, totalJob.id, job => job.status === 'budget_limit');
  assert.equal(totalDone.usage.totalTokens, 10);
  const toolOnly = await queuedPiFixture(t, [], { budgets: { maxTotalTokens: 5 } });
  const toolJob = await toolOnly.manager.start({ repository: toolOnly.repository, title: 'Tool only', prompt: '[FAKE_TEXTLESS_TOOL]' });
  const toolDone = await waitJob(toolOnly.manager, toolJob.id, job => job.status === 'budget_unavailable');
  assert.equal(toolDone.budget.status, 'unavailable');
});

test('cleanup preserves a shared session while referenced and removes it with all terminal jobs', { timeout: 30000 }, async t => {
  const { repository, manager } = await queuedPiFixture(t);
  const first = await manager.start({ repository, title: 'Cleanup', prompt: 'run' });
  const origin = await waitJob(manager, first.id, job => job.status === 'completed');
  const follow = await manager.start({ prompt: 'continue' }, first.id);
  await waitJob(manager, follow.id, job => job.status === 'completed');
  const partial = await manager.cleanup({ job_ids: [first.id] });
  assert.equal(partial.refused[0].reason, 'referenced');
  assert.equal(await fs.stat(origin.sessionDir).then(() => true, () => false), true);
  const complete = await manager.cleanup({ job_ids: [first.id, follow.id], dry_run: false });
  assert.deepEqual(new Set(complete.removed), new Set([first.id, follow.id]));
  assert.equal(await fs.stat(origin.sessionDir).then(() => true, () => false), false);
  assert.equal(await fs.stat(origin.worktree).then(() => true, () => false), false);
});

test('detached dispatcher admits queued jobs after MCP manager goes away', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-dispatch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const fake = new URL('./fixtures/fake-pi.mjs', import.meta.url).pathname;
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ piPath: process.execPath, piArgs: [fake], stateDir: path.join(root, 'state'), allowedRoots: [root],
    maxConcurrent: 1, provider: 'mock', model: 'mock', queue: { maxPending: 2, maxWaitSeconds: 30, dispatchIntervalMs: 100 },
    defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, defaultMaxTurns: 2 }));
  const config = await loadConfig(configFile);
  const manager = await new Manager(config, buildChildEnv(config)).init();
  const first = await manager.start({ repository, title: 'first', prompt: 'run first' });
  const second = await manager.start({ repository, title: 'second', prompt: 'run second' });
  let a, b;
  for (let i = 0; i < 150; i++) {
    [a, b] = await Promise.all([manager.read(first.id), manager.read(second.id)]);
    if (a.status === 'completed' && b.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(a.status, 'completed', a.error);
  assert.equal(b.status, 'completed', b.error);
  assert.ok(Date.parse(b.admittedAt) >= Date.parse(a.admittedAt));
});

test('persistent dispatcher admits enqueue after idle drain without a lost wakeup', { timeout: 30000 }, async t => {
  const { repository, manager } = await queuedPiFixture(t);
  const first = await manager.start({ repository, title: 'Before idle', prompt: 'run' });
  await waitJob(manager, first.id, job => job.status === 'completed');
  await new Promise(resolve => setTimeout(resolve, 1300));
  const second = await manager.start({ repository, title: 'After idle', prompt: 'run' });
  assert.equal((await waitJob(manager, second.id, job => job.status === 'completed')).status, 'completed');
});

test('startup dispatcher resumes persisted queued work after an MCP process restart', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-restart-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const fake = new URL('./fixtures/fake-pi.mjs', import.meta.url).pathname;
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ piPath: process.execPath, piArgs: [fake], stateDir: path.join(root, 'state'), allowedRoots: [root],
    provider: 'mock', model: 'mock', maxConcurrent: 1, defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, defaultMaxTurns: 2,
    queue: { maxPending: 2, maxWaitSeconds: 30, dispatchIntervalMs: 100 } }));
  const config = await loadConfig(configFile);
  const stopped = await new Manager(config, buildChildEnv(config), { spawnWorker: false }).init();
  const started = await stopped.start({ repository, title: 'Persisted queue', prompt: 'run' });
  assert.equal((await stopped.read(started.id)).status, 'queued');
  const restarted = await new Manager(config, buildChildEnv(config)).init();
  await restarted.ensureDispatcher();
  assert.equal((await waitJob(restarted, started.id, job => job.status === 'completed')).status, 'completed');
});
