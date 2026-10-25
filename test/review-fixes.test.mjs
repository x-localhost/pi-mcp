// Focused regression tests for the Unit C source-review fixes (see
// docs/llm-resilience-plan.md "Unit C"). Each test targets one confirmed
// defect found during the source review of the 0fd464f baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Manager, atomicJson } from '../src/manager.mjs';
import { validateConfig, loadConfig, buildChildEnv } from '../src/config.mjs';
import { processIdentity, groupState } from '../src/ownership.mjs';
import { RpcClient } from '../src/rpc.mjs';
import { snapshotArtifacts, attachArtifactReport, readArtifact, validateArtifactConfig } from '../src/artifacts.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dispatcherPath = fileURLToPath(new URL('../src/dispatcher.mjs', import.meta.url));

function gitRepo(root) {
  const repository = path.join(root, 'repo');
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  return { repository, git };
}

async function initRepo(root) {
  await fs.mkdir(root, { recursive: true });
  const { repository, git } = gitRepo(root);
  await fs.mkdir(repository);
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return { repository, git };
}

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-review-fixes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { repository, git } = await initRepo(root);
  const config = { stateDir: path.join(root, 'state'), allowedRoots: [root], maxConcurrent: 1, defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60,
    defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [], provider: 'mock', model: 'mock', ...overrides };
  const manager = await new Manager(config, { PATH: process.env.PATH }, { spawnWorker: false }).init();
  return { root, repository, git, config, manager };
}

// ---------------------------------------------------------------------------
// Fix 1: dispatcher.mjs dies silently when the submit lock is busy
// ---------------------------------------------------------------------------

test('dispatcher survives a busy submit lock and still dispatches the queued job instead of exiting silently', { timeout: 40000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-dispatcher-busy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { repository } = await initRepo(root);
  const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
  const configFile = path.join(root, 'config.json');
  const stateDir = path.join(root, 'state');
  await fs.writeFile(configFile, JSON.stringify({ piPath: process.execPath, piArgs: [fake], stateDir, allowedRoots: [root],
    maxConcurrent: 1, provider: 'mock', model: 'mock', queue: { maxPending: 3, maxWaitSeconds: 90, dispatchIntervalMs: 200 },
    defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, defaultMaxTurns: 2 }));
  const config = await loadConfig(configFile);
  // spawnWorker: false so this Manager's own ensureDispatcher() does not race
  // us to spawn the real dispatcher; we spawn it ourselves below, only after
  // the submit lock is already held, so the busy path is deterministic.
  const manager = await new Manager(config, buildChildEnv(config), { spawnWorker: false }).init();
  const queued = await manager.start({ repository, title: 'Busy lock', prompt: 'run' });
  assert.equal(queued.status, 'queued');

  const lockFile = path.join(manager.config.stateDir, 'submit.lock');
  const holder = spawn('/usr/bin/flock', ['-x', '-w', '15', lockFile, 'sh', '-c', 'printf "READY\\n"; sleep 10.5'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { holder.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => {
    let out = '';
    holder.stdout.on('data', chunk => { out += chunk.toString(); if (out.includes('READY\n')) resolve(); });
    holder.once('error', reject);
    holder.once('exit', code => { if (!out.includes('READY\n')) reject(new Error(`lock holder exited early (${code})`)); });
  });

  // Real dispatcher.mjs, started only after the submit lock is already busy:
  // its first manager.dispatchOnce() must hit the ~10s flock wait and fail
  // "Ownership lock busy" while the holder is still sleeping.
  const dispatcherChild = spawn(process.execPath, [dispatcherPath, configFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  let dispatcherStderr = '';
  dispatcherChild.stderr.on('data', chunk => { dispatcherStderr = (dispatcherStderr + chunk.toString()).slice(-4000); });
  t.after(() => { try { dispatcherChild.kill('SIGKILL'); } catch {} });

  let last;
  for (let i = 0; i < 300; i++) {
    last = await manager.read(queued.id);
    if (last.status === 'completed' || last.status === 'failed' || last.status === 'queue_expired') break;
    await delay(100);
  }
  assert.equal(last.status, 'completed', `job never completed; last status ${last.status}; dispatcher stderr: ${dispatcherStderr}`);
});

// ---------------------------------------------------------------------------
// Fix 2: RpcClient attaches no 'error' listener to the output stream
// ---------------------------------------------------------------------------

function recordingOutput() {
  const output = new EventEmitter();
  output.writes = 0;
  output.write = (data, cb) => { output.writes++; if (cb) cb(); return true; };
  return output;
}

test('RpcClient fails pending requests when the output stream errors instead of an uncaught exception', async () => {
  const input = new PassThrough();
  const output = recordingOutput();
  const rpc = new RpcClient(input, output);
  const pending = rpc.request('prompt', { message: 'hi' }, 5000);
  assert.equal(output.writes, 1);
  output.emit('error', new Error('write EPIPE'));
  await assert.rejects(pending, /EPIPE/);
});

test('RpcClient rejects requests made after the output stream already failed, without writing to it', async () => {
  const input = new PassThrough();
  const output = recordingOutput();
  const rpc = new RpcClient(input, output);
  output.emit('error', new Error('write EPIPE'));
  await assert.rejects(rpc.request('abort', {}, 1000), /EPIPE|closed/i);
  assert.equal(output.writes, 0);
});

// ---------------------------------------------------------------------------
// Fix 3: stale terminal-status list in internal-agent/export-artifacts.mjs
// and the artifacts.mjs sanitizeReportJson status allowlist
// ---------------------------------------------------------------------------

test('manager exports a terminal status set including context, idle and tool-failure limits', async () => {
  const { TERMINAL_STATUSES } = await import('../src/manager.mjs');
  assert.ok(TERMINAL_STATUSES, 'manager.mjs must export TERMINAL_STATUSES');
  for (const status of ['completed', 'failed', 'cancelled', 'timed_out', 'turn_limit', 'interrupted', 'queue_expired',
    'budget_limit', 'budget_unavailable', 'context_limit', 'idle_timeout', 'tool_failure_limit']) {
    assert.ok(TERMINAL_STATUSES.has(status), status);
  }
});

test('export-artifacts.mjs reuses manager.mjs TERMINAL_STATUSES instead of its own stale inline list', async () => {
  const source = await fs.readFile(fileURLToPath(new URL('../internal-agent/export-artifacts.mjs', import.meta.url)), 'utf8');
  assert.match(source, /TERMINAL_STATUSES/, 'must reference the shared terminal status set');
  assert.match(source, /from\s+'\.\.\/src\/manager\.mjs'/, 'must import from src/manager.mjs');
  for (const status of ['context_limit', 'idle_timeout', 'tool_failure_limit']) {
    assert.doesNotMatch(source, new RegExp(status), `must not hardcode ${status} instead of reusing the shared set`);
  }
});

async function artifactFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-review-artifacts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); const jobDir = path.join(root, 'job');
  await fs.mkdir(repo); await fs.mkdir(jobDir);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return { root, repo, jobDir, baseCommit: git('rev-parse', 'HEAD') };
}

test('result report status allowlist exempts context_limit, idle_timeout and tool_failure_limit from free-text redaction', async t => {
  const { repo, jobDir, baseCommit } = await artifactFixture(t);
  const config = validateArtifactConfig({});
  for (const status of ['context_limit', 'idle_timeout', 'tool_failure_limit']) {
    await fs.rm(path.join(jobDir, 'artifacts'), { recursive: true, force: true });
    await snapshotArtifacts({ jobDir, worktree: repo, baseCommit, config });
    await fs.writeFile(path.join(jobDir, 'result.json'), JSON.stringify({ status }));
    // The admin-named env secret deliberately collides with the status text
    // itself, the same way the pre-existing statuses in the allowlist are
    // exempted from this generic redaction regardless of such a collision.
    const manifest = await attachArtifactReport({ jobDir, name: 'result', file: 'result.json', config, env: { CORP_SECRET: status } });
    const entry = manifest.entries.find(item => item.path === 'reports/result');
    assert.ok(entry, status);
    assert.equal(entry.redacted, false, status);
    const data = await readArtifact(jobDir, { artifact_id: entry.id, offset: 0, length: 4096 });
    assert.equal(JSON.parse(Buffer.from(data.data_base64, 'base64').toString()).status, status);
  }
});

// ---------------------------------------------------------------------------
// Fix 4: retention scan bound default, actionable admission/submission and
// submission errors, and pi_health not throwing
// ---------------------------------------------------------------------------

test('retention default maxScanEntries matches the raised upper bound of 1,000,000', () => {
  const base = { piPath: '/bin/true', stateDir: '/tmp/pi-state', allowedRoots: ['/tmp'], provider: 'mock', model: 'mock' };
  assert.equal(validateConfig(base, '/tmp').retention.maxScanEntries, 1000000);
});

test('submission reports an actionable error when the retention scan bound is exceeded', async t => {
  const { repository, manager } = await fixture(t, { retention: { maxStateBytes: 1048576, maxScanEntries: 5, terminalDays: 7 } });
  const many = path.join(manager.config.stateDir, 'many'); await fs.mkdir(many);
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(many, String(i)), 'x');
  await assert.rejects(manager.start({ repository, title: 'Scan bound', prompt: 'run' }), /scan bound exceeded; run pi_cleanup or raise retention\.maxScanEntries/i);
});

test('admission reports an actionable error when the retention scan bound is exceeded', async t => {
  const { repository, manager } = await fixture(t, { retention: { maxStateBytes: 1048576, maxScanEntries: 1000, terminalDays: 7 },
    queue: { maxPending: 2, maxWaitSeconds: 60, dispatchIntervalMs: 100 } });
  const queued = await manager.start({ repository, title: 'Scan bound admission', prompt: 'run' });
  assert.equal(queued.status, 'queued');
  manager.config.retention.maxScanEntries = 5;
  const many = path.join(manager.config.stateDir, 'many'); await fs.mkdir(many);
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(many, String(i)), 'x');
  await manager.dispatchOnce();
  const failed = await manager.read(queued.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /scan bound exceeded; run pi_cleanup or raise retention\.maxScanEntries/i);
});

test('pi_health reports a storage scan error instead of throwing when the bound is exceeded', async t => {
  const { manager } = await fixture(t, { piPath: '/bin/echo', piArgs: ['1.4.0'], retention: { maxStateBytes: 1048576, maxScanEntries: 5, terminalDays: 7 } });
  const many = path.join(manager.config.stateDir, 'many'); await fs.mkdir(many);
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(many, String(i)), 'x');
  const health = await manager.health();
  assert.match(health.storage.error, /scan bound exceeded; run pi_cleanup or raise retention\.maxScanEntries/i);
});

test('docs/completion-runtime.md example default matches the raised maxScanEntries bound', async () => {
  const doc = await fs.readFile(fileURLToPath(new URL('../docs/completion-runtime.md', import.meta.url)), 'utf8');
  assert.match(doc, /"retention":\s*\{[^}]*"maxScanEntries":\s*1000000/);
});

// ---------------------------------------------------------------------------
// Fix 5: quarantine dead-end when the worker identity was never recorded
// ---------------------------------------------------------------------------

test('launchWorker records worker identity immediately so a crash before run() still allows recovery', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-review-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { stateDir: path.join(root, 'state'), allowedRoots: [root], maxConcurrent: 1, defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60,
    defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [], provider: 'mock', model: 'mock' };
  const manager = await new Manager(config, { PATH: process.env.PATH }, {}).init();
  const id = `task-${randomUUID()}`;
  const dir = manager.jobDir(id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // sessionDir deliberately does not exist: worker.mjs's very first
  // meaningful statement (fs.realpath(job.sessionDir), before refreshSecrets
  // or run()) throws, so the worker crashes before it ever gets to set
  // job.workerIdentity itself.
  const job = { id, sessionDir: path.join(root, 'missing-session'), status: 'starting', provider: 'mock', model: 'mock',
    title: 'Crash before run', worktree: path.join(root, 'wt'), branch: 'codex/pi/x', baseCommit: '0'.repeat(40), createdAt: new Date().toISOString() };
  await atomicJson(path.join(dir, 'job.json'), job);
  await manager.launchWorker(job);

  const afterLaunch = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
  assert.equal(afterLaunch.workerIdentity, undefined, 'launchWorker must not rewrite job.json from its stale copy');
  const launchedIdentity = JSON.parse(await fs.readFile(path.join(dir, 'worker-identity.json'), 'utf8'));
  const pid = Number(await fs.readFile(path.join(dir, 'worker.pid'), 'utf8'));
  assert.equal(launchedIdentity.pid, pid);

  let worker;
  for (let i = 0; i < 100; i++) {
    worker = await groupState(launchedIdentity);
    if (worker.state === 'stopped') break;
    await delay(100);
  }
  assert.equal(worker.state, 'stopped', `worker never stopped: ${JSON.stringify(worker)}`);

  await atomicJson(path.join(dir, 'job.json'), { ...afterLaunch, status: 'quarantined', error: 'test-induced crash before run()' });
  const inspected = await manager.recoverJob(id);
  assert.equal(inspected.recoverable, true, JSON.stringify(inspected));
  const recovered = await manager.recoverJob(id, { terminate: true });
  assert.equal(recovered.status, 'interrupted', JSON.stringify(recovered));
});
