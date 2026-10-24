// Contract tests for the offline/live harness evaluation suite (evals/).
//
// Trace record shape (candidate run outcome), allow-listed top-level keys only:
//   taskId, runId, origin: 'synthetic'|'live',
//   harnessCommit, taskBaseCommit (git SHA-1, 40 lowercase hex),
//   configFingerprint ('sha256:' + 64 lowercase hex),
//   execution: { jobId, status: 'completed'|'failed'|'incomplete', codeDigest (64-hex, null iff incomplete) },
//   artifacts: { changedPaths: string[], unchangedPaths: string[] },
//   verification: { jobId, codeDigest, contractDigest, verifierIds: string[], status: 'passed'|'failed' } | null,
//   review: { jobId, reviewJobId, codeDigest, contractDigest, verdict: 'approved'|'rejected' } | null,
//   retainedConstraintIds: string[],
//   resumeEvents: [{ eventId, requestId, jobId }],
//   eventsTruncated: boolean,
//   timing: { durationMs } | null,
//   usageAvailability: { totalTokens: 'available'|'unavailable', costUsd: 'available'|'unavailable' },
//   usage: { totalTokens: number|null, costUsd: number|null, observedResponses: number }
//
// All SHA-256 fields (codeDigest, contractDigest, configFingerprint's hex part)
// are exactly 64 lowercase hex characters. harnessCommit/taskBaseCommit are git
// SHA-1 commit ids (40 lowercase hex). These are two different identity
// families and must never be confused.
//
// Grading contract (binding, not self-reported):
//  - verification/review are only trusted when verification.jobId/review.jobId
//    equals execution.jobId (same job), codeDigest equals execution.codeDigest
//    (not stale), and contractDigest equals the grader's OWN taskContractDigest(task)
//    (never compared against another self-reported value). A verifier id not
//    in the task's own requiredVerifierIds does not satisfy the requirement.
//  - constraintRetention is 'retained' only when every required constraint ID
//    is both claimed in retainedConstraintIds AND independently confirmed via
//    artifacts.unchangedPaths; a claimed ID alone is never sufficient.
//  - resumeCorrectness is 'unknown' when eventsTruncated is true (a gapped
//    history cannot prove correctness either way); 'incorrect' when one
//    requestId maps to more than one distinct jobId, or resume was required
//    but no events occurred; 'correct' when every requestId maps to exactly
//    one jobId (repeats of the same mapping are valid idempotency evidence).
//  - usage/latency aggregates track observed/applicable/unknown counts and a
//    mean value that is null (never 0) when nothing was observed; totalTokens
//    and costUsd are independent dimensions.
//  - Missing outcomes for selected task IDs count as graded failures in the
//    success denominator, and in the retention/resume applicable denominators
//    for tasks that require them.
//  - Malformed data (bad hex, unknown fields, duplicate record ids, unbounded
//    arrays, conflicting batch identity) throws SchemaError and never reaches
//    grading; a well-formed record describing a negative outcome (false
//    completion, stale evidence, a duplicated resume mapping, ...) is a
//    graded failure and must never throw.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { SchemaError, ProvenanceError } from '../evals/errors.mjs';
import { parseTask, parseTrace, parseTraceBatch, taskContractDigest } from '../evals/schema.mjs';
import { loadSuite } from '../evals/suite.mjs';
import { gradeTask, gradeSuite, GRADER_VERSION } from '../evals/grader.mjs';
import { buildReport, writeReport } from '../evals/report.mjs';
import { compareReports } from '../evals/compare.mjs';
import { submitLiveRun, pollLiveRun } from '../evals/live-adapter.mjs';
import { Manager } from '../src/manager.mjs';
import { sha256Hex, stableStringify } from '../evals/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const CLI = path.join(repoRoot, 'scripts', 'evaluate-harness.mjs');

const HARNESS_COMMIT = 'a'.repeat(40);
const TASK_BASE_COMMIT = 'b'.repeat(40);
const CONFIG_FINGERPRINT = `sha256:${'5'.repeat(64)}`;
const FRESH_DIGEST = 'c'.repeat(64);
const STALE_DIGEST = 'd'.repeat(64);
const WRONG_CONTRACT_DIGEST = 'e'.repeat(64);

function baseTask(overrides = {}) {
  return parseTask({
    id: 'fix-null-check',
    scenario: 'successful_completion',
    prompt: 'Fix the null check in the parser without changing its public API.',
    criteria: [{ id: 'artifact', kind: 'artifact', description: 'Parser file is edited.' }],
    expectedEvidence: {
      changedPaths: ['src/parser.mjs'],
      requiredVerifierIds: ['lint'],
      requiresReview: false,
      requiresResume: false,
      requiredConstraintIds: ['preserve-public-api'],
      constraintEvidence: [{ constraintId: 'preserve-public-api', path: 'src/parser-api.mjs' }],
    },
    ...overrides,
  });
}

function baseTrace(task, overrides = {}) {
  return parseTrace({
    taskId: task.id,
    runId: 'run-1',
    origin: 'synthetic',
    harnessCommit: HARNESS_COMMIT,
    taskBaseCommit: TASK_BASE_COMMIT,
    configFingerprint: CONFIG_FINGERPRINT,
    execution: { jobId: 'job-1', status: 'completed', codeDigest: FRESH_DIGEST },
    artifacts: { changedPaths: ['src/parser.mjs'], presentPaths: ['src/parser.mjs'], unchangedPaths: ['src/parser-api.mjs'] },
    verification: { jobId: 'job-1', codeDigest: FRESH_DIGEST, contractDigest: taskContractDigest(task), verifierIds: ['lint'], status: 'passed' },
    review: null,
    retainedConstraintIds: ['preserve-public-api'],
    resumeEvents: [],
    eventsTruncated: false,
    timing: { durationMs: 1200 },
    usageAvailability: { totalTokens: 'available', costUsd: 'available' },
    usage: { totalTokens: 500, costUsd: 0.01, observedResponses: 2 },
    ...overrides,
  });
}

// --- Schema boundaries: malformed data vs. negative (graded) outcomes -----

test('parseTask rejects a malformed id distinctly from a graded negative outcome', () => {
  assert.throws(() => parseTask({ id: 'Not Valid ID', scenario: 'successful_completion', prompt: 'x',
    criteria: [], expectedEvidence: { changedPaths: [], requiredVerifierIds: [], requiresReview: false, requiresResume: false, requiredConstraintIds: [], constraintEvidence: [] } }), SchemaError);
  const task = baseTask();
  assert.doesNotThrow(() => gradeTask(task, baseTrace(task, { artifacts: { changedPaths: [], presentPaths: [], unchangedPaths: ['src/parser-api.mjs'] } })));
});

test('parseTask rejects conflicting constraint identities: a dangling required ID or an orphan evidence entry', () => {
  const raw = { id: 'dangling-constraint', scenario: 'successful_completion', prompt: 'x', criteria: [],
    expectedEvidence: { changedPaths: [], requiredVerifierIds: [], requiresReview: false, requiresResume: false,
      requiredConstraintIds: ['preserve-api'], constraintEvidence: [] } };
  assert.throws(() => parseTask(raw), SchemaError);
  const orphan = { ...raw, expectedEvidence: { ...raw.expectedEvidence, requiredConstraintIds: [], constraintEvidence: [{ constraintId: 'preserve-api', path: 'x.mjs' }] } };
  assert.throws(() => parseTask(orphan), SchemaError);
});

test('parseTrace rejects a SHA-256 field that is not exactly 64 lowercase hex characters', () => {
  const task = baseTask();
  assert.throws(() => baseTrace(task, { execution: { jobId: 'job-1', status: 'completed', codeDigest: 'stale'.padEnd(64, '0') } }), SchemaError);
});

test('parseTrace rejects an unknown top-level field (no trusted candidate-declared pass flag)', () => {
  const task = baseTask();
  const raw = { ...baseTrace(task), passed: true };
  assert.throws(() => parseTrace(raw), SchemaError);
});

test('parseTrace rejects unbounded resumeEvents and a duplicate eventId within one record', () => {
  const task = baseTask();
  const tooMany = Array.from({ length: 65 }, (_, i) => ({ eventId: `e${i}`, requestId: 'r1', jobId: 'job-1' }));
  assert.throws(() => baseTrace(task, { resumeEvents: tooMany }), SchemaError);
  const duplicateEventId = [
    { eventId: 'dup', requestId: 'r1', jobId: 'job-1' },
    { eventId: 'dup', requestId: 'r2', jobId: 'job-2' },
  ];
  assert.throws(() => baseTrace(task, { resumeEvents: duplicateEventId }), SchemaError);
});

test('parseTrace rejects an internally contradictory usageAvailability/usage pairing', () => {
  const task = baseTask();
  assert.throws(() => baseTrace(task, { usageAvailability: { totalTokens: 'unavailable', costUsd: 'available' }, usage: { totalTokens: 5, costUsd: 0.1, observedResponses: 1 } }), SchemaError);
  assert.throws(() => baseTrace(task, { usageAvailability: { totalTokens: 'available', costUsd: 'available' }, usage: { totalTokens: 5, costUsd: 0.1, observedResponses: 0 } }), SchemaError);
});

test('parseTraceBatch rejects duplicate taskId records, oversized batches, and conflicting run identity', () => {
  const taskA = baseTask({ id: 'task-a' });
  const taskB = baseTask({ id: 'task-b' });
  assert.throws(() => parseTraceBatch([baseTrace(taskA), baseTrace({ ...taskA })]), SchemaError);
  const many = Array.from({ length: 65 }, (_, i) => baseTrace(baseTask({ id: `task-${i}` })));
  assert.throws(() => parseTraceBatch(many), SchemaError);
  assert.throws(() => parseTraceBatch([baseTrace(taskA), baseTrace(taskB, { runId: 'different-run' })]), SchemaError);
  assert.doesNotThrow(() => parseTraceBatch([baseTrace(taskA), baseTrace(taskB)]));
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

// --- Grading: binding verifier/review proof to this exact job/contract -----

test('gradeTask: successful completion passes when evidence is bound to this exact job, code digest and contract', () => {
  const task = baseTask();
  const result = gradeTask(task, baseTrace(task));
  assert.equal(result.taskSuccess, true);
  assert.equal(result.constraintRetention, 'retained');
});

test('gradeTask: false completion is a graded failure, not a thrown error, despite status "completed" and verification "passed"', () => {
  const task = baseTask();
  const trace = baseTrace(task, { artifacts: { changedPaths: [], presentPaths: [], unchangedPaths: ['src/parser-api.mjs'] } });
  const result = gradeTask(task, trace);
  assert.equal(result.taskSuccess, false);
  assert.ok(result.criteria.some(c => c.id === 'artifact' && c.outcome === 'fail'));
});

test('gradeTask: declaring a retained-constraint ID alone never passes retention without independent evidence', () => {
  const task = baseTask();
  const trace = baseTrace(task, { artifacts: { changedPaths: ['src/parser.mjs'], presentPaths: ['src/parser.mjs'], unchangedPaths: [] } });
  const result = gradeTask(task, trace);
  assert.equal(result.constraintRetention, 'lost');
});

test('gradeTask: verification proof belonging to a different job does not satisfy the requirement', () => {
  const task = baseTask();
  const trace = baseTrace(task, { verification: { jobId: 'job-SOMEONE-ELSE', codeDigest: FRESH_DIGEST, contractDigest: taskContractDigest(task), verifierIds: ['lint'], status: 'passed' } });
  const result = gradeTask(task, trace);
  const criterion = result.criteria.find(c => c.id === 'verification');
  assert.equal(criterion.outcome, 'fail');
  assert.equal(criterion.reason, 'wrong_job');
  assert.equal(result.taskSuccess, false);
});

test('gradeTask: stale verification evidence (codeDigest mismatch) fails even though status is "passed"', () => {
  const task = baseTask();
  const trace = baseTrace(task, { verification: { jobId: 'job-1', codeDigest: STALE_DIGEST, contractDigest: taskContractDigest(task), verifierIds: ['lint'], status: 'passed' } });
  const result = gradeTask(task, trace);
  const criterion = result.criteria.find(c => c.id === 'verification');
  assert.equal(criterion.outcome, 'fail');
  assert.equal(criterion.reason, 'stale_evidence');
  assert.equal(result.taskSuccess, false);
});

test('gradeTask: verification against the wrong contract (grader-computed, not self-reported) fails', () => {
  const task = baseTask();
  const trace = baseTrace(task, { verification: { jobId: 'job-1', codeDigest: FRESH_DIGEST, contractDigest: WRONG_CONTRACT_DIGEST, verifierIds: ['lint'], status: 'passed' } });
  const result = gradeTask(task, trace);
  const criterion = result.criteria.find(c => c.id === 'verification');
  assert.equal(criterion.outcome, 'fail');
  assert.equal(criterion.reason, 'contract_mismatch');
});

test('gradeTask: a verifier that is not among the selected required verifier IDs does not satisfy the requirement', () => {
  const task = baseTask();
  const trace = baseTrace(task, { verification: { jobId: 'job-1', codeDigest: FRESH_DIGEST, contractDigest: taskContractDigest(task), verifierIds: ['some-other-verifier'], status: 'passed' } });
  const result = gradeTask(task, trace);
  const criterion = result.criteria.find(c => c.id === 'verification');
  assert.equal(criterion.outcome, 'fail');
  assert.equal(criterion.reason, 'missing_verifier');
});

test('gradeTask: stale review evidence fails the same way as stale verification, even when verification is fresh', () => {
  const task = baseTask({ expectedEvidence: { ...baseTask().expectedEvidence, requiresReview: true } });
  const trace = baseTrace(task, { review: { jobId: 'job-1', reviewJobId: 'job-review-1', codeDigest: STALE_DIGEST, contractDigest: taskContractDigest(task), verdict: 'approved' } });
  const result = gradeTask(task, trace);
  const criterion = result.criteria.find(c => c.id === 'review');
  assert.equal(criterion.outcome, 'fail');
  assert.equal(criterion.reason, 'stale_evidence');
  assert.equal(result.taskSuccess, false);
});

test('gradeTask: partial execution keeps completion unknown and independently grades file preservation', () => {
  const task = baseTask();
  const trace = baseTrace(task, { execution: { jobId: 'job-1', status: 'incomplete', codeDigest: null }, verification: null });
  const result = gradeTask(task, trace);
  assert.equal(result.taskSuccess, false);
  assert.ok(result.criteria.filter(c => c.kind !== 'constraint').every(c => c.outcome === 'unknown'));
  assert.equal(result.constraintRetention, 'retained');
});

test('gradeTask: failed execution fails completion while preserving observed unchanged file evidence', () => {
  const task = baseTask();
  const trace = baseTrace(task, { execution: { jobId: 'job-1', status: 'failed', codeDigest: FRESH_DIGEST }, verification: null });
  const result = gradeTask(task, trace);
  assert.equal(result.taskSuccess, false);
  assert.ok(result.criteria.filter(c => c.kind !== 'constraint').every(c => c.outcome === 'fail'));
  assert.equal(result.constraintRetention, 'retained');
});

test('gradeTask: duplicate resume request mapped to two different jobs is a graded failure', () => {
  const task = baseTask({ expectedEvidence: { ...baseTask().expectedEvidence, requiresResume: true } });
  const trace = baseTrace(task, { resumeEvents: [
    { eventId: 'e1', requestId: 'r1', jobId: 'job-1' },
    { eventId: 'e2', requestId: 'r1', jobId: 'job-2' },
  ] });
  const result = gradeTask(task, trace);
  assert.equal(result.resumeCorrectness, 'incorrect');
  assert.equal(result.taskSuccess, false);
});

test('gradeTask: repeated submission mapping the same request to the same job is valid idempotency, not a failure', () => {
  const task = baseTask({ expectedEvidence: { ...baseTask().expectedEvidence, requiresResume: true } });
  const trace = baseTrace(task, { resumeEvents: [
    { eventId: 'e1', requestId: 'r1', jobId: 'job-1' },
    { eventId: 'e2', requestId: 'r1', jobId: 'job-1' },
  ] });
  const result = gradeTask(task, trace);
  assert.equal(result.resumeCorrectness, 'correct');
  assert.equal(result.taskSuccess, true);
});

test('gradeTask: a gapped/truncated resume history cannot prove resume correctness either way', () => {
  const task = baseTask({ expectedEvidence: { ...baseTask().expectedEvidence, requiresResume: true } });
  const trace = baseTrace(task, { resumeEvents: [], eventsTruncated: true });
  const result = gradeTask(task, trace);
  assert.equal(result.resumeCorrectness, 'unknown');
  assert.equal(result.taskSuccess, false);
});

// --- gradeSuite: denominators, usage/cost dimensions -----------------------

test('gradeSuite: a missing outcome counts in the success denominator AND the retention/resume applicable denominators', () => {
  const resumeTask = baseTask({ id: 'resume-task', expectedEvidence: { ...baseTask().expectedEvidence, requiredConstraintIds: [], constraintEvidence: [], requiresResume: true } });
  const otherTask = baseTask({ id: 'other-task' });
  const tasks = [otherTask, resumeTask];
  const traces = [baseTrace(otherTask)]; // resumeTask has no outcome at all
  const result = gradeSuite({ suite: { tasks }, traces, selectedTaskIds: ['other-task', 'resume-task'] });
  assert.equal(result.taskSuccess.total, 2);
  assert.equal(result.resumeCorrectness.applicable, 1);
  assert.equal(result.resumeCorrectness.unknown, 1);
  assert.equal(result.constraintRetention.applicable, 1); // only otherTask requires constraints
  const missing = result.perTask.find(item => item.taskId === 'resume-task');
  assert.equal(missing.taskSuccess, false);
  assert.equal(missing.reason, 'missing_outcome');
});

test('gradeSuite: totalTokens and costUsd are independent dimensions; an all-unavailable set reports null, never 0', () => {
  const task = baseTask();
  const trace = baseTrace(task, { usageAvailability: { totalTokens: 'unavailable', costUsd: 'available' }, usage: { totalTokens: null, costUsd: 0.5, observedResponses: 1 } });
  const single = gradeTask(task, trace);
  assert.equal(single.usage.totalTokens, null);
  assert.equal(single.usage.costUsd, 0.5);
  const suiteResult = gradeSuite({ suite: { tasks: [task] }, traces: [trace], selectedTaskIds: [task.id] });
  assert.equal(suiteResult.usage.totalTokens.value, null);
  assert.equal(suiteResult.usage.totalTokens.observedCount, 0);
  assert.equal(suiteResult.usage.costUsd.value, 0.5);
  assert.equal(suiteResult.usage.costUsd.observedCount, 1);
});

// --- Determinism, provenance and comparison ---------------------------------

test('gradeSuite output is deterministic for identical inputs (no ambient time/randomness)', () => {
  const task = baseTask();
  const traces = [baseTrace(task)];
  const first = gradeSuite({ suite: { tasks: [task] }, traces, selectedTaskIds: [task.id] });
  const second = gradeSuite({ suite: { tasks: [task] }, traces, selectedTaskIds: [task.id] });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});

function makeReport(task, traces, overrides = {}) {
  const result = gradeSuite({ suite: { tasks: [task] }, traces, selectedTaskIds: [task.id] });
  return buildReport({
    suite: { tasks: [task], digest: sha256Hex(stableStringify([task])), version: 'v1' },
    graderVersion: GRADER_VERSION,
    selectedTaskIds: [task.id],
    harnessCommit: HARNESS_COMMIT,
    taskBaseCommit: TASK_BASE_COMMIT,
    configFingerprint: CONFIG_FINGERPRINT,
    origin: 'synthetic',
    traces,
    result,
    ...overrides,
  });
}

test('buildReport distinguishes harnessCommit from taskBaseCommit and allow-lists evidence fields', async () => {
  const task = baseTask();
  const report = makeReport(task, [baseTrace(task)]);
  assert.equal(report.harnessCommit, HARNESS_COMMIT);
  assert.equal(report.taskBaseCommit, TASK_BASE_COMMIT);
  assert.notEqual(report.harnessCommit, report.taskBaseCommit);
  assert.equal(report.origin, 'synthetic');
  assert.match(report.note, /synthetic/i);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['authHeaders', 'rawSession', 'apiKey', 'credential']) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `report leaked disallowed field: ${forbidden}`);
  }
});

test('buildReport rejects a report whose declared provenance does not match an included trace\'s own provenance', () => {
  const task = baseTask();
  const mismatched = baseTrace(task, { origin: 'synthetic' });
  mismatched.harnessCommit = 'f'.repeat(40); // forged after parsing: pretend it came from a different harness
  const result = gradeSuite({ suite: { tasks: [task] }, traces: [mismatched], selectedTaskIds: [task.id] });
  assert.throws(() => buildReport({
    suite: { tasks: [task], digest: sha256Hex(stableStringify([task])), version: 'v1' }, graderVersion: GRADER_VERSION, selectedTaskIds: [task.id],
    harnessCommit: HARNESS_COMMIT, taskBaseCommit: TASK_BASE_COMMIT, configFingerprint: CONFIG_FINGERPRINT,
    origin: 'synthetic', traces: [mismatched], result,
  }), ProvenanceError);
});

test('writeReport writes owner-private, non-overwriting output to an explicit destination', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-eval-report-'));
  const destination = path.join(tmp, 'report.json');
  await writeReport(destination, { ok: true });
  const stat = await fs.stat(destination);
  assert.equal(stat.mode & 0o777, 0o600);
  await assert.rejects(writeReport(destination, { ok: true }), /EEXIST|exists/i);
});

test('compareReports refuses incompatible suite/grader/config/origin provenance, but allows an intentionally different taskBaseCommit', () => {
  const task = baseTask();
  const baseline = makeReport(task, [baseTrace(task)]);
  const sameProvenanceDifferentSource = makeReport(task, [baseTrace(task, { taskBaseCommit: 'd'.repeat(40) })], { taskBaseCommit: 'd'.repeat(40) });
  assert.doesNotThrow(() => compareReports(baseline, sameProvenanceDifferentSource));
  const incompatibleConfig = makeReport(task, [baseTrace(task, { configFingerprint: `sha256:${'9'.repeat(64)}` })], { configFingerprint: `sha256:${'9'.repeat(64)}` });
  assert.throws(() => compareReports(baseline, incompatibleConfig), ProvenanceError);
});

test('compareReports refuses mismatched task selection by default, names the gap, and reports matched coverage only when allowed', () => {
  const taskA = baseTask({ id: 'task-a' });
  const taskB = baseTask({ id: 'task-b' });
  const baselineResult = gradeSuite({ suite: { tasks: [taskA, taskB] }, traces: [baseTrace(taskA), baseTrace(taskB)], selectedTaskIds: ['task-a', 'task-b'] });
  const candidateResult = gradeSuite({ suite: { tasks: [taskA] }, traces: [baseTrace(taskA)], selectedTaskIds: ['task-a'] });
  const comparedSuite = { tasks: [taskA, taskB], digest: sha256Hex(stableStringify([taskA, taskB])), version: 'v1' };
  const baseline = buildReport({ suite: comparedSuite, graderVersion: GRADER_VERSION, selectedTaskIds: ['task-a', 'task-b'],
    harnessCommit: HARNESS_COMMIT, taskBaseCommit: TASK_BASE_COMMIT, configFingerprint: CONFIG_FINGERPRINT, origin: 'synthetic', traces: [baseTrace(taskA), baseTrace(taskB)], result: baselineResult });
  const candidate = buildReport({ suite: comparedSuite, graderVersion: GRADER_VERSION, selectedTaskIds: ['task-a'],
    harnessCommit: HARNESS_COMMIT, taskBaseCommit: TASK_BASE_COMMIT, configFingerprint: CONFIG_FINGERPRINT, origin: 'synthetic', traces: [baseTrace(taskA)], result: candidateResult });
  assert.throws(() => compareReports(baseline, candidate), /task-b/);
  const comparison = compareReports(baseline, candidate, { allowSelectionMismatch: true, allowObservedMismatch: true });
  assert.deepEqual(comparison.taskSelection.onlyBaseline, ['task-b']);
  assert.deepEqual(comparison.taskSelection.matched, ['task-a']);
});

test('compareReports computes latency/cost deltas only from matched observed cases and reports success differences', () => {
  const task = baseTask();
  const baselineTrace = baseTrace(task, { timing: { durationMs: 1000 } });
  const candidateTrace = baseTrace(task, { timing: null, artifacts: { changedPaths: [], presentPaths: [], unchangedPaths: ['src/parser-api.mjs'] } }); // regressed: now fails, and latency unobserved
  const baseline = makeReport(task, [baselineTrace]);
  const candidate = makeReport(task, [candidateTrace]);
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.latencyMs.matchedObservedCount, 0); // candidate has no observed latency, so nothing is "matched observed"
  assert.equal(comparison.taskSuccess.changedTasks.length, 1);
  assert.equal(comparison.taskSuccess.changedTasks[0].taskId, task.id);
  assert.equal(comparison.taskSuccess.changedTasks[0].baseline, true);
  assert.equal(comparison.taskSuccess.changedTasks[0].candidate, false);
});

// --- CLI: replay, compare, and the live acknowledgement guard ---------------

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20000, ...options });
}

test('CLI replay runs fully offline against the bundled synthetic fixture and prints a deterministic report', () => {
  const result = runCli(['replay', '--fixture', 'baseline', '--harness-commit', '1'.repeat(40), '--task-base-commit', '2'.repeat(40), '--config-fingerprint', `sha256:${'3'.repeat(64)}`], { env: {} });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.origin, 'synthetic');
  assert.ok(report.result.perTask.some(item => item.reason === 'missing_outcome'));
});

test('CLI replay rejects a malformed/oversized traces file with a non-zero exit and does not crash uncaught', () => {
  const result = runCli(['replay', '--traces', '/nonexistent-traces-file.json', '--harness-commit', '1'.repeat(40), '--task-base-commit', '2'.repeat(40), '--config-fingerprint', `sha256:${'3'.repeat(64)}`]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Error/);
});

test('CLI replay --out writes owner-private, non-overwriting JSON and refuses to clobber an existing report', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-eval-cli-'));
  const out = path.join(tmp, 'report.json');
  const args = ['replay', '--fixture', 'baseline', '--harness-commit', '1'.repeat(40), '--task-base-commit', '2'.repeat(40), '--config-fingerprint', `sha256:${'3'.repeat(64)}`, '--out', out];
  const first = runCli(args);
  assert.equal(first.status, 0, first.stderr);
  const stat = await fs.stat(out);
  assert.equal(stat.mode & 0o777, 0o600);
  const second = runCli(args);
  assert.notEqual(second.status, 0);
});

test('CLI compare reports a regression between the baseline and regressed synthetic fixtures', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-eval-cli-compare-'));
  const baselineOut = path.join(tmp, 'baseline.json');
  const candidateOut = path.join(tmp, 'candidate.json');
  const commonArgs = ['--harness-commit', '1'.repeat(40), '--task-base-commit', '2'.repeat(40), '--config-fingerprint', `sha256:${'3'.repeat(64)}`];
  assert.equal(runCli(['replay', '--fixture', 'baseline', ...commonArgs, '--out', baselineOut]).status, 0);
  assert.equal(runCli(['replay', '--fixture', 'regressed', ...commonArgs, '--out', candidateOut]).status, 0);
  const compared = runCli(['compare', '--baseline', baselineOut, '--candidate', candidateOut]);
  assert.equal(compared.status, 0, compared.stderr);
  const comparison = JSON.parse(compared.stdout);
  assert.ok(comparison.taskSuccess.changedTasks.some(item => item.taskId === 'fix-null-check'));
  assert.match(comparison.note, /synthetic/i);
});

test('CLI live refuses to proceed (and never needs config/credentials) without --live and the explicit --ack token', () => {
  const result = runCli(['live', '--run-id', 'r1', '--select', 'fix-null-check', '--repository', '/nonexistent-repo', '--base-commit', 'a'.repeat(40), '--state-dir', '/tmp/does-not-matter'], { env: {} });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--live/);
});

// --- Live adapter: explicit acknowledgement, pinned run identity, and ------
// restart/lost-response reconciliation using a real, no-spawn Manager
// (piPath '/bin/true', spawnWorker: false). No real Pi process, network,
// paid provider or credential is ever touched -- this is the project's own
// established pattern for a local "fake Manager" in tests.

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
    verification: { commands: [{ id: 'lint', argv: ['/usr/bin/true'], timeoutSeconds: 3, maxOutputBytes: 1000, readOnly: true }], maxSelected: 1 },
  }, {}, { spawnWorker: false }).init();
  const stateDir = path.join(tmp, 'eval-run-state');
  return { manager, repository, baseCommit, stateDir };
}

const LIVE_SUITE_DIGEST = sha256Hex('suite-digest-fixture');

test('submitLiveRun refuses to contact the Manager at all without explicit live acknowledgement', async () => {
  const { manager, repository, baseCommit, stateDir } = await makeFakeManagerFixture();
  const task = baseTask();
  const base = { manager, stateDir, runId: 'run-ack', suiteDigest: LIVE_SUITE_DIGEST, harnessCommit: HARNESS_COMMIT, selectedTaskIds: [task.id], task, repository, baseCommit };
  await assert.rejects(submitLiveRun({ ...base, acknowledgeLive: false }), /acknowledge|live/i);
  await assert.rejects(submitLiveRun(base), /acknowledge|live/i);
  const jobs = await fs.readdir(manager.jobsDir).catch(() => []);
  assert.equal(jobs.length, 0, 'no job should be created before explicit live acknowledgement');
  const stateFiles = await fs.readdir(path.join(manager.config.stateDir, 'evaluation-runs')).catch(() => []);
  assert.equal(stateFiles.length, 0, 'no run state should be written before explicit live acknowledgement');
});

test('submitLiveRun is idempotent across a simulated restart (no in-memory cache, only the persisted stateDir)', async () => {
  const { manager, repository, baseCommit, stateDir } = await makeFakeManagerFixture();
  const task = baseTask();
  const base = { manager, stateDir, runId: 'run-retry', suiteDigest: LIVE_SUITE_DIGEST, harnessCommit: HARNESS_COMMIT, selectedTaskIds: [task.id], task, repository, baseCommit, acknowledgeLive: true };
  const first = await submitLiveRun(base);
  const restarted = await submitLiveRun(base); // a fresh call with no shared JS state, simulating an adapter restart
  assert.equal(restarted.jobId, first.jobId);
  const jobs = await fs.readdir(manager.jobsDir);
  assert.equal(jobs.length, 1, 'retry/restart must not create a second job');
});

test('submitLiveRun reconciles a lost submit response using the stable request id, without duplicating the job', async () => {
  const { manager, repository, baseCommit, stateDir } = await makeFakeManagerFixture();
  const task = baseTask();
  const base = { manager, stateDir, runId: 'run-lost', suiteDigest: LIVE_SUITE_DIGEST, harnessCommit: HARNESS_COMMIT, selectedTaskIds: [task.id], task, repository, baseCommit, acknowledgeLive: true };
  const first = await submitLiveRun(base);
  // Simulate a crash after the Manager created the job but before the
  // adapter's own record of its id was durably updated.
  const recordFile = (await fs.readdir(path.join(manager.config.stateDir, 'evaluation-runs'))).find(name => name.endsWith('.json'));
  const recordPath = path.join(manager.config.stateDir, 'evaluation-runs', recordFile);
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  record.tasks[task.id].jobId = null;
  await fs.writeFile(recordPath, JSON.stringify(record));
  const reconciled = await submitLiveRun(base);
  assert.equal(reconciled.jobId, first.jobId);
  const jobs = await fs.readdir(manager.jobsDir);
  assert.equal(jobs.length, 1, 'a lost response must reconcile to the same job, not a duplicate');
});

test('submitLiveRun rejects a changed configFingerprint or task selection under the same runId, before contacting the Manager', async () => {
  const { manager, repository, baseCommit, stateDir } = await makeFakeManagerFixture();
  const task = baseTask();
  const base = { manager, stateDir, runId: 'run-identity', suiteDigest: LIVE_SUITE_DIGEST, harnessCommit: HARNESS_COMMIT, selectedTaskIds: [task.id], task, repository, baseCommit, acknowledgeLive: true };
  await submitLiveRun(base);
  await assert.rejects(submitLiveRun({ ...base, configFingerprint: `sha256:${'9'.repeat(64)}` }), ProvenanceError);
  const otherTask = baseTask({ id: 'other-task' });
  await assert.rejects(submitLiveRun({ ...base, selectedTaskIds: [task.id, otherTask.id], tasks: [task, otherTask] }), ProvenanceError);
  const jobs = await fs.readdir(manager.jobsDir);
  assert.equal(jobs.length, 1, 'rejected identity changes must not create additional jobs');
});

test('submitLiveRun rejects changed task content under the same run/task identity, before contacting the Manager', async () => {
  const { manager, repository, baseCommit, stateDir } = await makeFakeManagerFixture();
  const task = baseTask();
  const base = { manager, stateDir, runId: 'run-content', suiteDigest: LIVE_SUITE_DIGEST, harnessCommit: HARNESS_COMMIT, selectedTaskIds: [task.id], task, repository, baseCommit, acknowledgeLive: true };
  await submitLiveRun(base);
  const changedTask = baseTask({ prompt: 'A completely different instruction.' });
  await assert.rejects(submitLiveRun({ ...base, task: changedTask }), ProvenanceError);
  const jobs = await fs.readdir(manager.jobsDir);
  assert.equal(jobs.length, 1);
});

test('submitLiveRun never performs automatic approval or review attestation, and exports no approval-capable function', async () => {
  const { manager, repository, baseCommit, stateDir } = await makeFakeManagerFixture();
  const task = baseTask();
  const submitted = await submitLiveRun({ manager, stateDir, runId: 'run-approve', suiteDigest: LIVE_SUITE_DIGEST, harnessCommit: HARNESS_COMMIT, selectedTaskIds: [task.id], task, repository, baseCommit, acknowledgeLive: true });
  const job = await manager.read(submitted.jobId);
  assert.ok(!job.reviewAttestations || job.reviewAttestations.length === 0);
  const liveAdapterModule = await import('../evals/live-adapter.mjs');
  for (const name of Object.keys(liveAdapterModule)) {
    assert.ok(!/approve|attest|commit|merge/i.test(name), `live-adapter must not export an approval-capable function: ${name}`);
  }
  // Only the explicitly constructed, allowlisted evidence is returned -- not
  // the full Manager job record (which includes prompt, worktree, etc.).
  assert.deepEqual(new Set(Object.keys(submitted)), new Set(['runId', 'taskId', 'jobId', 'requestId', 'status', 'origin', 'configFingerprint']));
});

test('pollLiveRun returns truthfully bounded status without fabricating completion, and preserves an unresolved error as null', async () => {
  const { manager, repository, baseCommit, stateDir } = await makeFakeManagerFixture();
  const task = baseTask();
  const submitted = await submitLiveRun({ manager, stateDir, runId: 'run-poll', suiteDigest: LIVE_SUITE_DIGEST, harnessCommit: HARNESS_COMMIT, selectedTaskIds: [task.id], task, repository, baseCommit, acknowledgeLive: true });
  const started = Date.now();
  const polled = await pollLiveRun({ manager, jobId: submitted.jobId, timeoutMs: 1000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, 'pollLiveRun must honor its timeout bound');
  assert.notEqual(polled.status, 'completed');
  assert.equal(polled.error, null);
});
