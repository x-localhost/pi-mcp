import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { Manager } from '../src/manager.mjs';

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const payload = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };

async function setup(overrides = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-wait-'));
  const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  await fs.chmod(fake, 0o755);
  const configFile = path.join(tmp, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ piPath: fake, stateDir: path.join(tmp, 'state'), allowedRoots: [tmp],
    provider: 'mock', model: 'mock', maxConcurrent: 4, defaultTimeoutSeconds: 60, maxTimeoutSeconds: 120, defaultMaxTurns: 2, ...overrides }));
  const client = new Client({ name: 'pi-mcp-wait-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, PI_MCP_CONFIG: configFile } });
  await client.connect(transport);
  const call = (name, args = {}, options) => client.callTool({ name, arguments: args }, undefined, options);
  return { tmp, repository, client, transport, call };
}
function cleanup(t, { client, transport, tmp }) {
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); });
}
async function waitStatus(call, id, predicate = status => status === 'completed', limit = 150) {
  let status;
  for (let i = 0; i < limit; i++) { status = payload(await call('pi_status', { job_id: id })).status; if (predicate(status)) return status; await delay(100); }
  throw new Error(`Status not reached: ${status}`);
}

test('pi_wait emits compact JSON and pi_capabilities advertises claudeCode.wait', { timeout: 20000 }, async t => {
  const session = await setup(); cleanup(t, session); const { repository, client, call } = session;
  const tools = (await client.listTools()).tools;
  const waitTool = tools.find(tool => tool.name === 'pi_wait');
  assert.ok(waitTool);
  assert.equal(waitTool.annotations.readOnlyHint, true);
  assert.match(waitTool.description, /drop/i);
  assert.match(waitTool.description, /until/i);
  const capRaw = await call('pi_capabilities');
  assert.ok(!capRaw.content[0].text.includes('\n'), capRaw.content[0].text);
  const capabilities = payload(capRaw);
  assert.deepEqual(capabilities.claudeCode, { version: 1, wait: { maxJobs: 8, defaultWaitSeconds: 45, maxWaitSeconds: 300, pollMs: 1000, progressMs: 10000 },
    patch: { maxPageBytes: 262144, defaultPageBytes: 65536, maxPatchBytes: 33554432 } });
  const started = payload(await call('pi_delegate', { repository, title: 'Compact', prompt: 'Do task' }));
  const waitRaw = await call('pi_wait', { job_ids: [started.id], wait_seconds: 10 });
  assert.ok(!waitRaw.content[0].text.includes('\n'), waitRaw.content[0].text);
  const result = payload(waitRaw);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.settled, [started.id]);
  assert.equal(result.jobs[0].status, 'completed');
  assert.equal(result.jobs[0].next, 'pi_result for the summary; pi_patch to review or apply');
});

test('until any resolves once the first job settles; until all keeps waiting', { timeout: 30000 }, async t => {
  const session = await setup(); cleanup(t, session); const { repository, call } = session;
  const fastJob = payload(await call('pi_delegate', { repository, title: 'Fast', prompt: 'Do task' }));
  const hangJob = payload(await call('pi_delegate', { repository, title: 'Hang', prompt: '[FAKE_HANG]' }));
  const anyResult = payload(await call('pi_wait', { job_ids: [fastJob.id, hangJob.id], wait_seconds: 15, until: 'any' }));
  assert.equal(anyResult.until, 'any');
  assert.equal(anyResult.timedOut, false);
  assert.deepEqual(anyResult.settled, [fastJob.id]);
  assert.deepEqual(anyResult.pending, [hangJob.id]);
  const allResult = payload(await call('pi_wait', { job_ids: [fastJob.id, hangJob.id], wait_seconds: 2, until: 'all' }));
  assert.equal(allResult.until, 'all');
  assert.equal(allResult.timedOut, true);
  assert.deepEqual(allResult.settled, [fastJob.id]);
  assert.deepEqual(allResult.pending, [hangJob.id]);
});

test('a wait with only pending jobs times out and reports them pending', { timeout: 15000 }, async t => {
  const session = await setup(); cleanup(t, session); const { repository, call } = session;
  const hangJob = payload(await call('pi_delegate', { repository, title: 'Hang', prompt: '[FAKE_HANG]' }));
  const before = Date.now();
  const result = payload(await call('pi_wait', { job_ids: [hangJob.id], wait_seconds: 2 }));
  const elapsedMs = Date.now() - before;
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.settled, []);
  assert.deepEqual(result.pending, [hangJob.id]);
  assert.ok(elapsedMs >= 1700 && elapsedMs < 6000, String(elapsedMs));
  assert.ok(result.elapsedSeconds >= 1.5 && result.elapsedSeconds <= 4, String(result.elapsedSeconds));
  assert.equal(result.jobs[0].next, 'pi_wait again');
});

test('a queued job is actually waited on, not resolved prematurely, through to completion', { timeout: 30000 }, async t => {
  const session = await setup({ maxConcurrent: 1, queue: { maxPending: 4, maxWaitSeconds: 60, dispatchIntervalMs: 100 } });
  cleanup(t, session); const { repository, call } = session;
  const blocker = payload(await call('pi_delegate', { repository, title: 'Blocker', prompt: '[FAKE_HANG]' }));
  const second = payload(await call('pi_delegate', { repository, title: 'Second', prompt: 'Do task' }));
  await waitStatus(call, blocker.id, status => status === 'running');
  assert.equal(payload(await call('pi_status', { job_id: second.id })).status, 'queued');
  const before = Date.now();
  const blocked = payload(await call('pi_wait', { job_ids: [second.id], wait_seconds: 2 }));
  assert.ok(Date.now() - before >= 1700);
  assert.equal(blocked.timedOut, true);
  assert.deepEqual(blocked.pending, [second.id]);
  assert.equal(blocked.jobs[0].status, 'queued');
  await call('pi_cancel', { job_id: blocker.id });
  const released = payload(await call('pi_wait', { job_ids: [second.id], wait_seconds: 20 }));
  assert.equal(released.timedOut, false);
  assert.deepEqual(released.settled, [second.id]);
  assert.equal(released.jobs[0].status, 'completed');
});

test('an already-settled job satisfies pi_wait immediately', { timeout: 20000 }, async t => {
  const session = await setup(); cleanup(t, session); const { repository, call } = session;
  const job = payload(await call('pi_delegate', { repository, title: 'Settled', prompt: 'Do task' }));
  await waitStatus(call, job.id);
  const before = Date.now();
  // wait_seconds is deliberately large: an already-settled job must return
  // immediately regardless of how long it was told it could wait.
  const result = payload(await call('pi_wait', { job_ids: [job.id], wait_seconds: 30 }));
  const elapsedMs = Date.now() - before;
  // A generous, load-tolerant threshold: this only needs to rule out
  // actually waiting out any part of wait_seconds, not prove microsecond
  // responsiveness.
  assert.ok(elapsedMs < 5000, String(elapsedMs));
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.settled, [job.id]);
  assert.ok(result.elapsedSeconds < 5, String(result.elapsedSeconds));
});

test('wait_seconds 0 makes exactly one observation round', { timeout: 20000 }, async t => {
  const session = await setup(); cleanup(t, session); const { repository, call } = session;
  const hangJob = payload(await call('pi_delegate', { repository, title: 'Hang', prompt: '[FAKE_HANG]' }));
  const beforePending = Date.now();
  const pendingResult = payload(await call('pi_wait', { job_ids: [hangJob.id], wait_seconds: 0 }));
  // Relaxed from a tight ~800ms threshold: this only needs to rule out a
  // second observation round (which would cost roughly another second of
  // polling), not prove sub-second responsiveness under load.
  assert.ok(Date.now() - beforePending < 5000);
  assert.equal(pendingResult.timedOut, true);
  assert.deepEqual(pendingResult.pending, [hangJob.id]);

  const fastJob = payload(await call('pi_delegate', { repository, title: 'Fast', prompt: 'Do task' }));
  await waitStatus(call, fastJob.id);
  const beforeSettled = Date.now();
  const settledResult = payload(await call('pi_wait', { job_ids: [fastJob.id], wait_seconds: 0 }));
  assert.ok(Date.now() - beforeSettled < 5000);
  assert.equal(settledResult.timedOut, false);
  assert.deepEqual(settledResult.settled, [fastJob.id]);
});

test('duplicate and unknown job_ids fail the call before any job is waited on', { timeout: 20000 }, async t => {
  const session = await setup(); cleanup(t, session); const { repository, call } = session;
  const job = payload(await call('pi_delegate', { repository, title: 'Dup', prompt: 'Do task' }));
  const duplicate = await call('pi_wait', { job_ids: [job.id, job.id] });
  assert.equal(duplicate.isError, true);
  const unknownId = 'task-00000000-0000-0000-0000-000000000000';
  const unknown = await call('pi_wait', { job_ids: [unknownId] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, new RegExp(`Job not found: ${unknownId}`));
});

test('a quarantined job counts as settled with an unsafe next hint', { timeout: 30000 }, async t => {
  const session = await setup(); const { tmp, repository, call } = session;
  const job = payload(await call('pi_delegate', { repository, title: 'Quarantine', prompt: '[FAKE_HANG]' }));
  const jobJsonPath = path.join(tmp, 'state', 'jobs', job.id, 'job.json');
  let workerPid, piPid;
  for (let i = 0; i < 100; i++) {
    const raw = JSON.parse(await fs.readFile(jobJsonPath, 'utf8'));
    if (raw.workerPid) { workerPid = raw.workerPid; piPid = raw.piPid; break; }
    await delay(100);
  }
  assert.ok(workerPid, 'worker never recorded its pid');
  t.after(async () => {
    try { process.kill(-piPid, 'SIGKILL'); } catch {}
    await session.client.close().catch(() => {}); await session.transport.close().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  process.kill(workerPid, 'SIGKILL');
  const result = payload(await call('pi_wait', { job_ids: [job.id], wait_seconds: 15 }));
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.settled, [job.id]);
  assert.equal(result.jobs[0].status, 'quarantined');
  assert.equal(result.jobs[0].settled, true);
  assert.equal(result.jobs[0].next, 'unsafe: report it; pi_recover inspects ownership');
});

test('progress notifications arrive only with a progress token, including token 0', { timeout: 30000 }, async t => {
  const session = await setup(); cleanup(t, session); const { repository, client, call } = session;

  const notesWithToken = [];
  client.setNotificationHandler(ProgressNotificationSchema, notification => { notesWithToken.push(notification.params); });
  const hangJob = payload(await call('pi_delegate', { repository, title: 'Hang', prompt: '[FAKE_HANG]' }));
  const withToken = payload(await client.request({ method: 'tools/call',
    params: { name: 'pi_wait', arguments: { job_ids: [hangJob.id], wait_seconds: 12 }, _meta: { progressToken: 0 } } }, CallToolResultSchema));
  assert.equal(withToken.timedOut, true);
  assert.ok(notesWithToken.length >= 1, JSON.stringify(notesWithToken));
  for (const note of notesWithToken) assert.equal(note.progressToken, 0);
  assert.equal(notesWithToken[0].total, 12);
  assert.match(notesWithToken[0].message, /^\d+\/1 settled$/);
  assert.ok(notesWithToken[0].progress >= 10, String(notesWithToken[0].progress));
  for (let i = 1; i < notesWithToken.length; i++) assert.ok(notesWithToken[i].progress > notesWithToken[i - 1].progress);

  const notesWithoutToken = [];
  client.setNotificationHandler(ProgressNotificationSchema, notification => { notesWithoutToken.push(notification.params); });
  const hangJob2 = payload(await call('pi_delegate', { repository, title: 'Hang2', prompt: '[FAKE_HANG]' }));
  const withoutToken = payload(await call('pi_wait', { job_ids: [hangJob2.id], wait_seconds: 3 }));
  assert.equal(withoutToken.timedOut, true);
  assert.equal(notesWithoutToken.length, 0);
});

test('client-side cancellation stops the wait while the job keeps running', { timeout: 20000 }, async t => {
  const session = await setup(); cleanup(t, session); const { repository, call } = session;
  const hangJob = payload(await call('pi_delegate', { repository, title: 'Hang', prompt: '[FAKE_HANG]' }));
  await waitStatus(call, hangJob.id, status => status === 'running');
  const controller = new AbortController();
  const waitPromise = call('pi_wait', { job_ids: [hangJob.id], wait_seconds: 10 }, { signal: controller.signal });
  await delay(1200);
  controller.abort();
  await assert.rejects(waitPromise);
  const status = payload(await call('pi_status', { job_id: hangJob.id })).status;
  assert.equal(status, 'running');
  const followUp = payload(await call('pi_wait', { job_ids: [hangJob.id], wait_seconds: 0 }));
  assert.deepEqual(followUp.pending, [hangJob.id]);
});

test('Manager.wait stops before onProgress when the signal aborts during an in-flight status read', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-wait-manager-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');

  // The first status() call is wait()'s initial per-id settle check (before
  // the polling loop even starts); the second is the first poll made from
  // inside that loop. Aborting partway through that second call reproduces
  // "the signal aborts while a status read is still in flight", which the
  // fix must catch immediately afterward, before onProgress is ever called
  // for that round.
  class AbortingManager extends Manager {
    constructor(...args) { super(...args); this.pollCount = 0; this.controller = null; }
    async status(id, waitSeconds) {
      if (this.pollCount === 1) { await delay(10500); this.controller.abort(); }
      this.pollCount++;
      return super.status(id, waitSeconds);
    }
  }
  const manager = await new AbortingManager({ stateDir, allowedRoots: [root] }, {}, { spawnWorker: false }).init();
  const id = `task-${randomUUID()}`;
  await fs.mkdir(manager.jobDir(id), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(manager.jobDir(id), 'job.json'),
    JSON.stringify({ id, status: 'running', createdAt: new Date().toISOString(), title: 'Hang' }));

  const controller = new AbortController();
  manager.controller = controller;
  let progressCalls = 0;
  const result = await manager.wait([id], { waitSeconds: 30, signal: controller.signal, onProgress: async () => { progressCalls++; } });
  assert.equal(controller.signal.aborted, true);
  assert.equal(progressCalls, 0);
  assert.deepEqual(result.pending, [id]);
});

// Shared by the two direct Manager.wait tests below: a bare pending job,
// with no worker and no worktree, sufficient for status()/public() to read
// without touching git at all.
async function makePendingJob(manager) {
  const id = `task-${randomUUID()}`;
  await fs.mkdir(manager.jobDir(id), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(manager.jobDir(id), 'job.json'),
    JSON.stringify({ id, status: 'running', createdAt: new Date().toISOString(), title: 'Hang' }));
  return id;
}

test('Manager.wait stops reading further job_ids once the signal aborts mid-sweep, before the polling loop starts', { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-wait-manager-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');

  // Aborts right as the SECOND job_id's initial status() read happens, so a
  // fix that only checks signal.aborted once (at entry, or only inside the
  // polling loop) would still go on to read the third id; this proves the
  // sweep itself is checked between reads.
  class AbortingDuringSweepManager extends Manager {
    constructor(...args) { super(...args); this.pollCount = 0; this.controller = null; }
    async status(id, waitSeconds) {
      this.pollCount++;
      if (this.pollCount === 2) this.controller.abort();
      return super.status(id, waitSeconds);
    }
  }
  const manager = await new AbortingDuringSweepManager({ stateDir, allowedRoots: [root] }, {}, { spawnWorker: false }).init();
  const ids = [await makePendingJob(manager), await makePendingJob(manager), await makePendingJob(manager)];

  const controller = new AbortController();
  manager.controller = controller;
  const result = await manager.wait(ids, { waitSeconds: 30, signal: controller.signal });
  assert.equal(controller.signal.aborted, true);
  assert.equal(manager.pollCount, 2, 'the third job_id must never be read once the signal aborted on the second');
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.jobs, []);
});

test('Manager.wait with wait_seconds:0 performs exactly one status() call per job_id, proving no polling round runs', { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-wait-manager-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');

  class CountingManager extends Manager {
    constructor(...args) { super(...args); this.statusCalls = 0; }
    async status(id, waitSeconds) { this.statusCalls++; return super.status(id, waitSeconds); }
  }
  const manager = await new CountingManager({ stateDir, allowedRoots: [root] }, {}, { spawnWorker: false }).init();
  const ids = [await makePendingJob(manager), await makePendingJob(manager), await makePendingJob(manager)];

  const result = await manager.wait(ids, { waitSeconds: 0 });
  assert.equal(manager.statusCalls, ids.length, 'wait_seconds:0 must make exactly one status() call per job_id, with no extra polling round');
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.pending, ids);
});

test('two pi_wait calls on the same job proceed independently in parallel', { timeout: 20000 }, async t => {
  const session = await setup(); cleanup(t, session); const { repository, call } = session;
  const hangJob = payload(await call('pi_delegate', { repository, title: 'Hang', prompt: '[FAKE_HANG]' }));
  const before = Date.now();
  const [first, second] = await Promise.all([
    call('pi_wait', { job_ids: [hangJob.id], wait_seconds: 3 }),
    call('pi_wait', { job_ids: [hangJob.id], wait_seconds: 3 }),
  ]);
  const elapsedMs = Date.now() - before;
  assert.ok(elapsedMs < 4500, String(elapsedMs));
  assert.equal(payload(first).timedOut, true);
  assert.equal(payload(second).timedOut, true);
});
