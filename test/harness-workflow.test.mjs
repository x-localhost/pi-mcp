import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Workflow, readWorkflowReferences } from '../src/workflow.mjs';
import { withOwnershipLock } from '../src/ownership.mjs';
import { Manager } from '../src/manager.mjs';
import { contractDigest } from '../src/acceptance.mjs';

class FakeManager {
  constructor(stateDir) { this.config = { stateDir }; this.jobs = []; this.calls = []; }
  lock(run) { return withOwnershipLock(path.join(this.config.stateDir, 'submit.lock'), run); }
  async read(id) { const job = this.jobs.find(item => item.id === id); if (!job) throw new Error('Job not found'); return structuredClone(job); }
  async all() { return structuredClone(this.jobs); }
  async start(input, parentId) { return this.lock(async () => {
    this.calls.push({ kind: parentId ? 'followup' : 'delegate', input, parentId });
    const existing = this.jobs.find(job => job.requestId === input.request_id);
    if (existing) return structuredClone(existing);
    const job = { id: `task-${randomUUID()}`, requestId: input.request_id, status: 'running', parentJobId: parentId, inputSnapshotDigest: 'a'.repeat(64) };
    this.jobs.push(job); if (this.throwAfterCreate) { this.throwAfterCreate = false; throw new Error('crash after submit'); } return structuredClone(job);
  }); }
  async review(id, input) { const result = await this.start(input); this.calls.at(-1).kind = 'review'; Object.assign(this.jobs.at(-1), { reviewSourceJobId: id, reviewSourceSnapshotDigest: 'a'.repeat(64), reviewSourceContractDigest: 'b'.repeat(64) }); return result; }
  async rollover(id, input, options) { const result = await this.start(input); this.calls.at(-1).kind = 'rollover'; this.calls.at(-1).options = options; Object.assign(this.jobs.at(-1), { rolloverFromId: id, rolloverSourceSnapshotDigest: 'a'.repeat(64) }); return result; }
  async cancel(id) { this.calls.push({ kind: 'cancel', id }); if (this.cancelFailOnce) { this.cancelFailOnce = false; throw new Error('delivery interrupted'); } return { id, cancellationRequested: true }; }
  complete(id, data = {}) { Object.assign(this.jobs.find(item => item.id === id), { status: 'completed', execution: { status: 'passed' }, verification: { status: 'passed' }, acceptance: { status: 'not_requested' }, artifacts: { inputSnapshotDigest: 'a'.repeat(64) }, usage: { totalTokens: 20, cost: { total: 0.2 } }, ...data }); }
}

const make = async () => { const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-workflow-')); const manager = new FakeManager(stateDir); return { stateDir, manager, workflow: new Workflow(manager), cleanup: () => fs.rm(stateDir, { recursive: true, force: true }) }; };
const stages = [
  { kind: 'delegate', input: { repository: '/workspace/repo', title: 'Task', prompt: 'SECRET_PROMPT' } },
  { kind: 'followup', input: { prompt: 'Continue' }, requires: ['execution', 'verification'] },
];

test('workflow persists intent, excludes private prompt from public status, and submits one child', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, title: 'Goal', stages });
    assert.equal(created.stage, 0);
    assert.equal(JSON.stringify(created).includes('SECRET_PROMPT'), false);
    const started = await f.workflow.advance(created.id);
    assert.equal(started.activeJobId, f.manager.jobs[0].id);
    assert.equal(f.manager.calls.length, 1);
    const refs = await readWorkflowReferences(f.stateDir);
    assert.ok(refs.jobIds.includes(started.activeJobId));
    assert.ok(refs.requestIds.includes(f.manager.jobs[0].requestId));
    assert.equal(JSON.stringify(await f.workflow.status(created.id)).includes('SECRET_PROMPT'), false);
    await f.workflow.advance(created.id);
    assert.equal(f.manager.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('workflow gates continuation and counts each child usage once', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages, budget: { maxTotalTokens: 100, maxCostUsd: 1 } });
    const first = await f.workflow.advance(created.id);
    assert.equal((await f.workflow.advance(created.id)).blockedReason, 'active_child');
    f.manager.complete(first.activeJobId);
    const second = await f.workflow.advance(created.id);
    assert.equal(second.activeJobId, f.manager.jobs[1].id);
    assert.equal(f.manager.calls.length, 2);
    assert.deepEqual(second.observedUsage, { totalTokens: 20, costUsd: 0.2 });
    await f.workflow.advance(created.id);
    assert.equal((await f.workflow.status(created.id)).observedUsage.totalTokens, 20);
  } finally { await f.cleanup(); }
});

test('unknown budget dimension blocks admission and cancellation intent survives retry', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages, budget: { maxCostUsd: 1 } });
    const first = await f.workflow.advance(created.id);
    f.manager.complete(first.activeJobId, { usage: { totalTokens: 20 } });
    const blocked = await f.workflow.advance(created.id);
    assert.equal(blocked.blockedReason, 'usage_unavailable');
    assert.equal(blocked.nextAction, 'blocked');
    assert.equal(f.manager.jobs.length, 1);
    await f.workflow.cancel(created.id);
    await f.workflow.cancel(created.id);
    assert.equal(f.manager.calls.filter(call => call.kind === 'cancel').length, 0);
    assert.equal((await f.workflow.status(created.id)).cancelRequested, true);
    assert.ok((await readWorkflowReferences(f.stateDir)).jobIds.includes(first.activeJobId));
  } finally { await f.cleanup(); }
});

test('cancellation intent is durable before delivery and retried on restart', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages });
    const started = await f.workflow.advance(created.id);
    f.manager.cancelFailOnce = true;
    await assert.rejects(f.workflow.cancel(created.id), /delivery interrupted/);
    assert.equal((await f.workflow.status(created.id)).cancelRequested, true);
    const resumed = new Workflow(f.manager);
    await resumed.advance(created.id);
    assert.equal(f.manager.calls.filter(call => call.kind === 'cancel').length, 2);
    assert.ok((await readWorkflowReferences(f.stateDir)).jobIds.includes(started.activeJobId));
  } finally { await f.cleanup(); }
});

test('prepared deterministic intent reconciles a child after submit-result loss', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages });
    f.manager.throwAfterCreate = true;
    await assert.rejects(f.workflow.advance(created.id), /crash after submit/);
    assert.equal(f.manager.jobs.length, 1);
    const refs = await readWorkflowReferences(f.stateDir);
    assert.ok(refs.requestIds.includes(f.manager.jobs[0].requestId));
    const resumed = new Workflow(f.manager);
    const reconciled = await resumed.advance(created.id);
    assert.equal(reconciled.activeJobId, f.manager.jobs[0].id);
    assert.equal(f.manager.calls.filter(call => call.kind === 'delegate').length, 1);
  } finally { await f.cleanup(); }
});

test('review may run pending acceptance; implementation waits for digest-bound acceptance', async () => {
  const f = await make();
  try {
    const plan = [stages[0], { kind: 'review', input: { prompt: 'Inspect code' } }, { kind: 'followup', input: { prompt: 'Fix findings' }, requires: ['execution', 'acceptance'] }];
    const created = await f.workflow.create({ version: 1, stages: plan, budget: { maxTotalTokens: 100 } });
    const first = await f.workflow.advance(created.id);
    f.manager.complete(first.activeJobId, { acceptance: { status: 'pending_review', sourceJobId: first.activeJobId, inputSnapshotDigest: 'a'.repeat(64), contractDigest: 'b'.repeat(64) } });
    const review = await f.workflow.advance(created.id);
    assert.equal(f.manager.calls.at(-1).kind, 'review');
    assert.equal(f.manager.calls.at(-1).input.request_id, review.stages[1].requestId);
    f.manager.complete(review.activeJobId);
    assert.equal((await f.workflow.advance(created.id)).blockedReason, 'acceptance_gate');
    assert.equal(f.manager.jobs.length, 2);
    f.manager.jobs[0].acceptance.status = 'accepted';
    const continuation = await f.workflow.advance(created.id);
    assert.equal(f.manager.calls.at(-1).kind, 'followup');
    assert.equal(f.manager.calls.at(-1).parentId, first.activeJobId);
    assert.deepEqual(continuation.observedUsage, { totalTokens: 40, costUsd: 0.4 });
  } finally { await f.cleanup(); }
});

test('release refuses active child, then drops cleanup references after terminal evidence', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages: [stages[0]] });
    const started = await f.workflow.advance(created.id);
    await assert.rejects(f.workflow.release(created.id), /complete or be cancelled/);
    f.manager.complete(started.activeJobId);
    await assert.rejects(f.workflow.release(created.id), /complete or be cancelled/);
    await f.workflow.advance(created.id);
    const released = await f.workflow.release(created.id);
    assert.equal(released.released, true);
    assert.deepEqual(await readWorkflowReferences(f.stateDir), { jobIds: [], requestIds: [] });
  } finally { await f.cleanup(); }
});

test('a final review waits for fresh source attestation before completion or release', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages: [stages[0], { kind: 'review', input: { prompt: 'Inspect' } }] });
    const first = await f.workflow.advance(created.id);
    f.manager.complete(first.activeJobId, { acceptance: { status: 'pending_review', contractDigest: 'b'.repeat(64) } });
    const reviewer = await f.workflow.advance(created.id);
    f.manager.complete(reviewer.activeJobId);
    const pending = await f.workflow.advance(created.id);
    assert.equal(pending.nextAction, 'await_attestation');
    assert.equal(pending.blockedReason, 'acceptance_gate');
    await assert.rejects(f.workflow.release(created.id), /complete or be cancelled/);
    f.manager.jobs[0].acceptance.status = 'accepted';
    const accepted = await f.workflow.advance(created.id);
    assert.equal(accepted.nextAction, 'complete');
    assert.equal((await f.workflow.release(created.id)).released, true);
  } finally { await f.cleanup(); }
});

test('a later delegate waits for required source acceptance after review', async () => {
  const f = await make();
  try {
    const next = { kind: 'delegate', input: { repository: '/workspace/second', title: 'Next', prompt: 'Next task' } };
    const created = await f.workflow.create({ version: 1, stages: [stages[0], { kind: 'review', input: { prompt: 'Inspect' } }, next] });
    const first = await f.workflow.advance(created.id);
    f.manager.complete(first.activeJobId, { acceptance: { status: 'pending_review', contractDigest: 'b'.repeat(64) } });
    const reviewer = await f.workflow.advance(created.id);
    f.manager.complete(reviewer.activeJobId);
    assert.equal((await f.workflow.advance(created.id)).blockedReason, 'acceptance_gate');
    assert.equal(f.manager.jobs.length, 2);
    f.manager.jobs[0].acceptance.status = 'accepted';
    const nextJob = await f.workflow.advance(created.id);
    assert.equal(nextJob.stages[2].sourceJobId, first.activeJobId);
    assert.equal(f.manager.jobs.length, 3);
  } finally { await f.cleanup(); }
});

test('reconciliation rejects changed source checkpoint and mismatched child identity', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages: [stages[0], { kind: 'review', input: { prompt: 'Inspect' } }] });
    const first = await f.workflow.advance(created.id);
    f.manager.complete(first.activeJobId, { acceptance: { status: 'pending_review', contractDigest: 'b'.repeat(64) } });
    f.manager.throwAfterCreate = true;
    await assert.rejects(f.workflow.advance(created.id), /crash after submit/);
    f.manager.jobs[0].artifacts.inputSnapshotDigest = 'c'.repeat(64);
    await assert.rejects(f.workflow.advance(created.id), /intent or source changed/);
    f.manager.jobs[0].artifacts.inputSnapshotDigest = 'a'.repeat(64);
    f.manager.jobs[1].reviewSourceContractDigest = 'd'.repeat(64);
    await assert.rejects(f.workflow.advance(created.id), /different child/);
  } finally { await f.cleanup(); }
});

test('rollover submits explicitly and reconciles its immutable source checkpoint', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages: [stages[0], { kind: 'rollover', input: { prompt: 'Continue in fresh session' } }] });
    const first = await f.workflow.advance(created.id);
    f.manager.complete(first.activeJobId);
    const submitted = await f.workflow.advance(created.id);
    assert.deepEqual(f.manager.calls.at(-1).options, { automatic: false });
    const file = path.join(f.stateDir, 'workflows', `${created.id}.json`);
    const store = JSON.parse(await fs.readFile(file, 'utf8'));
    store.stages[1].jobId = undefined;
    await fs.writeFile(file, JSON.stringify(store));
    const recovered = await new Workflow(f.manager).advance(created.id);
    assert.equal(recovered.activeJobId, submitted.activeJobId);
    assert.equal(f.manager.calls.filter(call => call.kind === 'rollover').length, 1);
  } finally { await f.cleanup(); }
});

test('workflow state paths reject symlinks and malformed goal IDs before lock creation', async () => {
  const f = await make();
  try {
    await assert.rejects(f.workflow.advance('../../escape'), /Invalid goal id/);
    const created = await f.workflow.create({ version: 1, stages });
    const dir = path.join(f.stateDir, 'workflows');
    await fs.rename(path.join(dir, 'locks'), path.join(dir, 'saved-locks'));
    await fs.symlink(path.join(dir, 'saved-locks'), path.join(dir, 'locks'));
    await assert.rejects(f.workflow.advance(created.id), /Unsafe workflow directory/);
  } finally { await f.cleanup(); }
});

test('create refuses a full bounded workflow directory', async () => {
  const f = await make();
  try {
    await f.workflow.create({ version: 1, stages });
    const dir = path.join(f.stateDir, 'workflows');
    const names = Array.from({ length: 1023 }, (_, index) => `placeholder-${index}.json`);
    await Promise.all(names.map(name => fs.writeFile(path.join(dir, name), '{}')));
    await assert.rejects(f.workflow.create({ version: 1, stages }), /capacity reached/);
  } finally { await f.cleanup(); }
});

test('cleanup reference reader fails closed on corrupt and symlinked workflow files', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages });
    const file = path.join(f.stateDir, 'workflows', `${created.id}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.stages[0].input.prompt = 'tampered';
    await fs.writeFile(file, JSON.stringify(raw));
    await assert.rejects(readWorkflowReferences(f.stateDir), /plan changed/i);
    await fs.rm(file);
    await fs.symlink('/etc/passwd', file);
    await assert.rejects(readWorkflowReferences(f.stateDir), /Unsafe workflow entry/);
  } finally { await f.cleanup(); }
});

test('cleanup reference reader rejects a symlinked state root and tampered intent', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages });
    await f.workflow.advance(created.id);
    const alias = `${f.stateDir}-alias`;
    await fs.symlink(f.stateDir, alias);
    try { await assert.rejects(readWorkflowReferences(alias), /Unsafe workflow state root/); }
    finally { await fs.rm(alias); }
    const file = path.join(f.stateDir, 'workflows', `${created.id}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.stages[0].intent.requestId = 'wf-forged-0';
    await fs.writeFile(file, JSON.stringify(raw));
    await assert.rejects(readWorkflowReferences(f.stateDir), /intent binding/);
  } finally { await f.cleanup(); }
});

test('cancel reconciles an orphan child from durable request id after lost submit result', async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages });
    f.manager.throwAfterCreate = true;
    await assert.rejects(f.workflow.advance(created.id), /crash after submit/);
    await f.workflow.cancel(created.id);
    assert.equal(f.manager.calls.at(-1).kind, 'cancel');
    assert.equal(f.manager.calls.at(-1).id, f.manager.jobs[0].id);
    assert.equal((await f.workflow.status(created.id)).activeJobId, f.manager.jobs[0].id);
  } finally { await f.cleanup(); }
});

test('two independent processes advancing one goal submit exactly one child', { timeout: 15_000 }, async () => {
  const f = await make();
  try {
    const created = await f.workflow.create({ version: 1, stages });
    await fs.writeFile(path.join(f.stateDir, 'fake-jobs.json'), '[]');
    const fixture = fileURLToPath(new URL('./fixtures/workflow-child.mjs', import.meta.url));
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fixture, f.stateDir, created.id], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', chunk => { out += chunk.toString(); });
      child.stderr.on('data', chunk => { err += chunk.toString(); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    });
    const [first, second] = await Promise.all([run(), run()]);
    const jobs = JSON.parse(await fs.readFile(path.join(f.stateDir, 'fake-jobs.json'), 'utf8'));
    assert.equal(jobs.length, 1);
    assert.equal(first.activeJobId, jobs[0].id);
    assert.equal(second.activeJobId, jobs[0].id);
  } finally { await f.cleanup(); }
});

test('real Manager recomputes acceptance and cleanup protects durable job and request IDs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-workflow-real-'));
  try {
    const repo = path.join(root, 'repo'); await fs.mkdir(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'base.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
    const manager = await new Manager({ stateDir: path.join(root, 'state'), allowedRoots: [root], maxConcurrent: 2,
      defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60, defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [],
      provider: 'mock', model: 'mock' }, {}, { spawnWorker: false }).init();
    const workflow = new Workflow(manager);
    const contract = { version: 1, require_review: true };
    const created = await workflow.create({ version: 1, stages: [
      { kind: 'delegate', input: { repository: repo, title: 'Source', prompt: 'Build', acceptance: contract } },
      { kind: 'followup', input: { prompt: 'Continue after review' } }
    ] });
    const first = await workflow.advance(created.id);
    const jobFile = path.join(manager.jobDir(first.activeJobId), 'job.json');
    const raw = await manager.read(first.activeJobId);
    const code = 'a'.repeat(64); const manifest = 'b'.repeat(64);
    Object.assign(raw, { status: 'completed', finishedAt: new Date().toISOString(), execution: { status: 'passed' },
      verification: { status: 'not_requested' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: code, manifestSha256: manifest },
      usage: { totalTokens: 10, cost: { total: 0.1 } }, acceptance: { status: 'accepted' } });
    await fs.writeFile(jobFile, JSON.stringify(raw));
    assert.equal((await manager.cleanup({ job_ids: [raw.id], dry_run: true })).refused[0].reason, 'referenced');
    const storeFile = path.join(manager.config.stateDir, 'workflows', `${created.id}.json`);
    const privateStore = JSON.parse(await fs.readFile(storeFile, 'utf8'));
    privateStore.stages[0].jobId = undefined;
    await fs.writeFile(storeFile, JSON.stringify(privateStore));
    assert.equal((await manager.cleanup({ job_ids: [raw.id], dry_run: true })).refused[0].reason, 'referenced');
    await workflow.advance(created.id); // Reattach by the saved request ID.
    const held = await workflow.advance(created.id);
    assert.equal(held.blockedReason, 'acceptance_gate');
    raw.reviewAttestations = [{ authority: 'caller', sourceJobId: raw.id, inputSnapshotDigest: code,
      contractDigest: contractDigest(contract), manifestSha256: manifest, verdict: 'approved' }];
    await fs.writeFile(jobFile, JSON.stringify(raw));
    const continued = await workflow.advance(created.id);
    assert.ok(continued.activeJobId);
    assert.equal((await manager.read(continued.activeJobId)).parentJobId, raw.id);
    const child = await manager.read(continued.activeJobId);
    child.status = 'completed'; child.finishedAt = new Date().toISOString(); child.execution = { status: 'passed' };
    child.usage = { totalTokens: 5, cost: { total: 0.05 } };
    await fs.writeFile(path.join(manager.jobDir(child.id), 'job.json'), JSON.stringify(child));
    assert.equal((await workflow.advance(created.id)).nextAction, 'await_attestation');
    await workflow.cancel(created.id);
    await workflow.release(created.id);
    const cleanup = await manager.cleanup({ job_ids: [raw.id, child.id], dry_run: true });
    assert.deepEqual(new Set(cleanup.candidates), new Set([raw.id, child.id]));
    const corrupt = JSON.parse(await fs.readFile(storeFile, 'utf8'));
    corrupt.stages[0].input.prompt = 'changed after release';
    await fs.writeFile(storeFile, JSON.stringify(corrupt));
    await assert.rejects(manager.cleanup({ job_ids: [raw.id], dry_run: true }), /plan changed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
