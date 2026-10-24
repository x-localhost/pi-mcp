// RED-phase contract tests for the offline/live harness evaluation suite.
// None of the imported `evals/*` modules exist yet; this file is expected to
// fail to load (module-not-found) until the GREEN implementation lands.
//
// Trace record shape (candidate run outcome), allow-listed top-level keys only:
//   taskId, runId, harnessCommit, taskBaseCommit, configFingerprint,
//   execution: { status: 'completed'|'failed'|'incomplete', codeDigest },
//   artifacts: { changedPaths: string[], unchangedPaths: string[] },
//   verification: { status: 'passed'|'failed', commandIds: string[], codeDigest } | null,
//   review: { verdict: 'approved'|'rejected', codeDigest } | null,
//   retainedConstraintIds: string[],
//   resumeEvents: [{ eventId, requestId, jobId }],
//   eventsTruncated: boolean,
//   timing: { durationMs } | null,
//   usageAvailability: 'available'|'unavailable',
//   usage: { totalTokens } | null
//
// Task record shape:
//   id, scenario, prompt, criteria: [{ id, kind, description }],
//   expectedEvidence: { changedPaths, unchangedPaths, requiresVerification,
//     requiresReview, requiresResume, requiredConstraintIds, constraintEvidence }
//
// Grading contract (for the GREEN implementation):
//  - A criterion never passes from a candidate's own declared/self-reported
//    status alone; it must be corroborated by independent evidence fields.
//  - constraintRetention is 'retained' only when every required constraint ID
//    appears in retainedConstraintIds AND its suite-owned evidence path
//    appears in artifacts.unchangedPaths; otherwise 'lost'. Not applicable
//    (no required IDs) is 'unknown'.
//  - verification/review evidence is stale (and must fail, category
//    'stale_evidence') when its codeDigest differs from execution.codeDigest.
//  - resumeCorrectness is 'unknown' when eventsTruncated is true (a gapped
//    history cannot prove correctness either way); 'incorrect' when one
//    requestId maps to more than one distinct jobId; 'correct' when every
//    requestId maps to exactly one jobId (repeats of the same mapping are
//    valid idempotency evidence, not a failure).
//  - usage/latency aggregates only count observed (available) values; an
//    all-unavailable set reports null, never 0.
//  - Missing outcomes for selected task IDs are graded failures counted in
//    the denominator, never silently dropped.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SchemaError } from '../evals/errors.mjs';
import { parseTask, parseTrace, parseTraceBatch } from '../evals/schema.mjs';
import { loadSuite } from '../evals/suite.mjs';
import { gradeTask, gradeSuite, GRADER_VERSION } from '../evals/grader.mjs';
import { buildReport, writeReport } from '../evals/report.mjs';
import { compareReports } from '../evals/compare.mjs';
import { submitLiveRun, pollLiveRun } from '../evals/live-adapter.mjs';
import { Manager } from '../src/manager.mjs';

const CONFIG_FINGERPRINT = 'sha256:config-test-fixture';
const HARNESS_COMMIT = 'a'.repeat(40);
const TASK_BASE_COMMIT = 'b'.repeat(40);

function baseTask(overrides = {}) {
  return parseTask({
    id: 'fix-null-check',
    scenario: 'successful_completion',
    prompt: 'Fix the null check in the parser without changing its public API.',
    criteria: [{ id: 'artifact-change', kind: 'artifact', description: 'Parser file is edited.' }],
    expectedEvidence: {
      changedPaths: ['src/parser.mjs'],
      requiresVerification: true,
      requiresReview: false,
      requiresResume: false,
      requiredConstraintIds: ['preserve-public-api'],
      constraintEvidence: [{ constraintId: 'preserve-public-api', path: 'src/parser-api.mjs' }],
    },
    ...overrides,
  });
}

function baseTrace(overrides = {}) {
  return parseTrace({
    taskId: 'fix-null-check',
    runId: 'run-1',
    harnessCommit: HARNESS_COMMIT,
    taskBaseCommit: TASK_BASE_COMMIT,
    configFingerprint: CONFIG_FINGERPRINT,
    execution: { status: 'completed', codeDigest: 'c'.repeat(64) },
    artifacts: { changedPaths: ['src/parser.mjs'], unchangedPaths: ['src/parser-api.mjs'] },
    verification: { status: 'passed', commandIds: ['lint'], codeDigest: 'c'.repeat(64) },
    review: null,
    retainedConstraintIds: ['preserve-public-api'],
    resumeEvents: [],
    eventsTruncated: false,
    timing: { durationMs: 1200 },
    usageAvailability: 'available',
    usage: { totalTokens: 500 },
    ...overrides,
  });
}

// --- Schema boundaries -----------------------------------------------------

test('parseTask rejects a malformed id distinctly from a graded negative outcome', () => {
  assert.throws(() => parseTask({ id: 'Not Valid ID', scenario: 'successful_completion', prompt: 'x',
    criteria: [], expectedEvidence: {} }), SchemaError);
  // A well-formed task/trace pair describing a false completion must NOT throw;
  // it is a graded failure, verified further down.
  assert.doesNotThrow(() => gradeTask(baseTask(), baseTrace({ artifacts: { changedPaths: [], unchangedPaths: ['src/parser-api.mjs'] } })));
});

test('parseTrace rejects unknown top-level fields (no trusted candidate-declared pass flag)', () => {
  const raw = { ...baseTrace(), passed: true };
  assert.throws(() => parseTrace(raw), SchemaError);
});

test('parseTrace rejects unbounded resumeEvents and duplicate eventId within a record', () => {
  const tooMany = Array.from({ length: 65 }, (_, i) => ({ eventId: `e${i}`, requestId: 'r1', jobId: 'job-1' }));
  assert.throws(() => parseTrace(baseTrace({ resumeEvents: tooMany })), SchemaError);
  const duplicateEventId = [
    { eventId: 'dup', requestId: 'r1', jobId: 'job-1' },
    { eventId: 'dup', requestId: 'r2', jobId: 'job-2' },
  ];
  assert.throws(() => parseTrace(baseTrace({ resumeEvents: duplicateEventId })), SchemaError);
});

test('parseTraceBatch rejects duplicate taskId records and oversized batches', () => {
  const a = baseTrace({ taskId: 'task-a' });
  const b = baseTrace({ taskId: 'task-a' });
  assert.throws(() => parseTraceBatch([a, b]), SchemaError);
  const many = Array.from({ length: 65 }, (_, i) => baseTrace({ taskId: `task-${i}` }));
  assert.throws(() => parseTraceBatch(many), SchemaError);
  assert.doesNotThrow(() => parseTraceBatch([baseTrace({ taskId: 'task-a' }), baseTrace({ taskId: 'task-b' })]));
});

// --- Versioned suite ---------------------------------------------------------

test('loadSuite exposes an immutable, de-duplicated 8-10 case suite with a stable digest', async () => {
  const first = await loadSuite();
  const second = await loadSuite();
  assert.ok(first.tasks.length >= 8 && first.tasks.length <= 10);
  const ids = first.tasks.map(task => task.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(first.digest, second.digest);
  const scenarios = new Set(first.tasks.map(task => task.scenario));
  for (const required of ['successful_completion', 'false_completion', 'lost_constraint', 'duplicate_resume',
    'stale_review', 'missing_outcome', 'unavailable_usage', 'event_gap_resume']) {
    assert.ok(scenarios.has(required), `suite missing required scenario coverage: ${required}`);
  }
});

// --- Grading: the nine required scenarios -----------------------------------

test('gradeTask: successful completion passes when evidence corroborates execution', () => {
  const result = gradeTask(baseTask(), baseTrace());
  assert.equal(result.taskSuccess, true);
  assert.equal(result.constraintRetention, 'retained');
});

test('gradeTask: false completion is a graded failure, not a thrown error, despite status "completed"', () => {
  const trace = baseTrace({ artifacts: { changedPaths: [], unchangedPaths: ['src/parser-api.mjs'] } });
  const result = gradeTask(baseTask(), trace);
  assert.equal(result.taskSuccess, false);
  assert.ok(result.criteria.some(c => c.outcome === 'fail'));
});

test('gradeTask: declaring a retained-constraint ID alone never passes retention', () => {
  // retainedConstraintIds claims the ID, but the evidence path was NOT independently
  // confirmed unchanged -- this must not be trusted as retained.
  const trace = baseTrace({ artifacts: { changedPaths: ['src/parser.mjs'], unchangedPaths: [] } });
  const result = gradeTask(baseTask(), trace);
  assert.equal(result.constraintRetention, 'lost');
});

test('gradeTask: duplicate resume request mapped to two different jobs is a graded failure', () => {
  const task = baseTask({ expectedEvidence: { ...baseTask().expectedEvidence, requiresResume: true } });
  const trace = baseTrace({ resumeEvents: [
    { eventId: 'e1', requestId: 'r1', jobId: 'job-1' },
    { eventId: 'e2', requestId: 'r1', jobId: 'job-2' },
  ] });
  const result = gradeTask(task, trace);
  assert.equal(result.resumeCorrectness, 'incorrect');
  assert.equal(result.taskSuccess, false);
});

test('gradeTask: repeated submission mapping the same request to the same job is valid idempotency, not a failure', () => {
  const task = baseTask({ expectedEvidence: { ...baseTask().expectedEvidence, requiresResume: true } });
  const trace = baseTrace({ resumeEvents: [
    { eventId: 'e1', requestId: 'r1', jobId: 'job-1' },
    { eventId: 'e2', requestId: 'r1', jobId: 'job-1' },
  ] });
  const result = gradeTask(task, trace);
  assert.equal(result.resumeCorrectness, 'correct');
});

test('gradeTask: stale verification evidence (codeDigest mismatch) fails even though status is "passed"', () => {
  const trace = baseTrace({ verification: { status: 'passed', commandIds: ['lint'], codeDigest: 'stale'.padEnd(64, '0') } });
  const result = gradeTask(baseTask(), trace);
  assert.equal(result.taskSuccess, false);
  const verificationCriterion = result.criteria.find(c => c.id === 'verification' || c.kind === 'verification');
  assert.ok(verificationCriterion);
  assert.equal(verificationCriterion.outcome, 'fail');
  assert.equal(verificationCriterion.reason, 'stale_evidence');
});

test('gradeTask: stale review evidence fails the same way as stale verification', () => {
  const task = baseTask({ expectedEvidence: { ...baseTask().expectedEvidence, requiresReview: true } });
  const trace = baseTrace({ review: { verdict: 'approved', codeDigest: 'stale'.padEnd(64, '0') } });
  const result = gradeTask(task, trace);
  assert.equal(result.taskSuccess, false);
  const reviewCriterion = result.criteria.find(c => c.id === 'review' || c.kind === 'review');
  assert.equal(reviewCriterion.outcome, 'fail');
  assert.equal(reviewCriterion.reason, 'stale_evidence');
});

test('gradeSuite: a missing outcome for a selected task counts as a graded failure in the denominator', () => {
  const tasks = [baseTask({ id: 'task-a' }), baseTask({ id: 'task-b' }), baseTask({ id: 'task-c' })];
  const traces = [baseTrace({ taskId: 'task-a' }), baseTrace({ taskId: 'task-b' })];
  const result = gradeSuite({ suite: { tasks }, traces, selectedTaskIds: ['task-a', 'task-b', 'task-c'] });
  assert.equal(result.taskSuccess.total, 3);
  const missing = result.perTask.find(item => item.taskId === 'task-c');
  assert.equal(missing.taskSuccess, false);
  assert.equal(missing.reason, 'missing_outcome');
});

test('gradeTask/gradeSuite: unavailable usage stays null, never coerced to zero', () => {
  const trace = baseTrace({ usageAvailability: 'unavailable', usage: null });
  const single = gradeTask(baseTask(), trace);
  assert.equal(single.usage, null);
  const suiteResult = gradeSuite({ suite: { tasks: [baseTask()] }, traces: [trace], selectedTaskIds: ['fix-null-check'] });
  assert.equal(suiteResult.usage.totalTokens, null);
  assert.equal(suiteResult.usage.observedCount, 0);
});

test('gradeTask: a gapped/truncated resume history cannot prove resume correctness either way', () => {
  const task = baseTask({ expectedEvidence: { ...baseTask().expectedEvidence, requiresResume: true } });
  const trace = baseTrace({ resumeEvents: [], eventsTruncated: true });
  const result = gradeTask(task, trace);
  assert.equal(result.resumeCorrectness, 'unknown');
  assert.equal(result.taskSuccess, false);
});

// --- Determinism, provenance and comparison ---------------------------------

test('gradeSuite output is deterministic for identical inputs (no ambient time/randomness)', () => {
  const tasks = [baseTask()];
  const traces = [baseTrace()];
  const first = gradeSuite({ suite: { tasks }, traces, selectedTaskIds: ['fix-null-check'] });
  const second = gradeSuite({ suite: { tasks }, traces, selectedTaskIds: ['fix-null-check'] });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});

test('buildReport distinguishes harnessCommit from taskBaseCommit and allow-lists evidence fields', async () => {
  const tasks = [baseTask()];
  const traces = [baseTrace()];
  const graded = gradeSuite({ suite: { tasks }, traces, selectedTaskIds: ['fix-null-check'] });
  const report = buildReport({
    suite: { tasks, digest: 'suite-digest-fixture', version: 'v1' },
    graderVersion: GRADER_VERSION,
    selectedTaskIds: ['fix-null-check'],
    harnessCommit: HARNESS_COMMIT,
    taskBaseCommit: TASK_BASE_COMMIT,
    configFingerprint: CONFIG_FINGERPRINT,
    result: graded,
  });
  assert.equal(report.harnessCommit, HARNESS_COMMIT);
  assert.equal(report.taskBaseCommit, TASK_BASE_COMMIT);
  assert.notEqual(report.harnessCommit, report.taskBaseCommit);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['authHeaders', 'rawSession', 'apiKey', 'credential']) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `report leaked disallowed field: ${forbidden}`);
  }
});

test('writeReport writes owner-private, non-overwriting output to an explicit destination', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-eval-report-'));
  const destination = path.join(tmp, 'report.json');
  await writeReport(destination, { ok: true });
  const stat = await fs.stat(destination);
  assert.equal(stat.mode & 0o777, 0o600);
  await assert.rejects(writeReport(destination, { ok: true }), /EEXIST|exists/i);
});

test('compareReports refuses incompatible suite/grader/config provenance but allows an intentionally different taskBaseCommit', async () => {
  const tasks = [baseTask()];
  const traces = [baseTrace()];
  const graded = gradeSuite({ suite: { tasks }, traces, selectedTaskIds: ['fix-null-check'] });
  const makeReport = overrides => buildReport({
    suite: { tasks, digest: 'suite-digest-fixture', version: 'v1' },
    graderVersion: GRADER_VERSION,
    selectedTaskIds: ['fix-null-check'],
    harnessCommit: HARNESS_COMMIT,
    taskBaseCommit: TASK_BASE_COMMIT,
    configFingerprint: CONFIG_FINGERPRINT,
    result: graded,
    ...overrides,
  });
  const baseline = makeReport({});
  const sameProvenance = makeReport({ taskBaseCommit: 'd'.repeat(40) });
  assert.doesNotThrow(() => compareReports(baseline, sameProvenance));
  const incompatible = makeReport({ configFingerprint: 'sha256:different-config' });
  assert.throws(() => compareReports(baseline, incompatible), /incompatible|provenance/i);
});

// --- Live adapter: explicit acknowledgement and retry identity -------------
// The "fake Manager" required by the plan is the project's own Manager class
// run the same way existing unit tests already run it for isolation: no real
// Pi binary (piPath '/bin/true') and spawnWorker disabled, so no worker/pi
// process is ever spawned and no network or paid provider is touched.

async function makeFakeManagerFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-eval-live-'));
  const repository = path.join(tmp, 'repo');
  await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base');
  git('add', '.'); git('commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  const manager = await new Manager({
    stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 4,
    defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60, defaultMaxTurns: 2,
    piPath: '/bin/true', allowedCommands: [], provider: 'mock', model: 'mock-model',
  }, {}, { spawnWorker: false }).init();
  return { manager, repository, baseCommit };
}

test('submitLiveRun refuses to contact the Manager at all without explicit live acknowledgement', async () => {
  const { manager, repository, baseCommit } = await makeFakeManagerFixture();
  const task = baseTask();
  await assert.rejects(submitLiveRun({ manager, task, runId: 'run-ack', repository, baseCommit, acknowledgeLive: false }), /acknowledge|live/i);
  await assert.rejects(submitLiveRun({ manager, task, runId: 'run-ack', repository, baseCommit }), /acknowledge|live/i);
  const jobs = await fs.readdir(manager.jobsDir).catch(() => []);
  assert.equal(jobs.length, 0, 'no job should be created before explicit live acknowledgement');
});

test('submitLiveRun is idempotent for a retried identical run and rejects a changed payload under the same run identity', async () => {
  const { manager, repository, baseCommit } = await makeFakeManagerFixture();
  const task = baseTask();
  const first = await submitLiveRun({ manager, task, runId: 'run-retry', repository, baseCommit, acknowledgeLive: true });
  const retried = await submitLiveRun({ manager, task, runId: 'run-retry', repository, baseCommit, acknowledgeLive: true });
  assert.equal(retried.jobId, first.jobId);
  const changedTask = baseTask({ prompt: 'A completely different instruction.' });
  await assert.rejects(submitLiveRun({ manager, task: changedTask, runId: 'run-retry', repository, baseCommit, acknowledgeLive: true }), /different|identity|mismatch/i);
});

test('submitLiveRun never performs automatic approval or review attestation', async () => {
  const { manager, repository, baseCommit } = await makeFakeManagerFixture();
  const task = baseTask();
  const submitted = await submitLiveRun({ manager, task, runId: 'run-approve', repository, baseCommit, acknowledgeLive: true });
  const job = await manager.read(submitted.jobId);
  assert.ok(!job.reviewAttestations || job.reviewAttestations.length === 0);
  const liveAdapterModule = await import('../evals/live-adapter.mjs');
  for (const name of Object.keys(liveAdapterModule)) {
    assert.ok(!/approve|attest|commit|merge/i.test(name), `live-adapter must not export an approval-capable function: ${name}`);
  }
});

test('pollLiveRun returns truthfully bounded status without fabricating completion', async () => {
  const { manager, repository, baseCommit } = await makeFakeManagerFixture();
  const task = baseTask();
  const submitted = await submitLiveRun({ manager, task, runId: 'run-poll', repository, baseCommit, acknowledgeLive: true });
  // spawnWorker is disabled, so this job can never actually progress; the
  // adapter must still return within the bound rather than hang or lie.
  const started = Date.now();
  const polled = await pollLiveRun({ manager, jobId: submitted.jobId, timeoutMs: 1000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, 'pollLiveRun must honor its timeout bound');
  assert.notEqual(polled.status, 'completed');
});
