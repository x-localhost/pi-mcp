// Pure offline grader: evidence consistency checks only, never authenticity.
// No ambient time, randomness, filesystem or network access -- gradeTask and
// gradeSuite are plain functions of their arguments so that identical inputs
// always produce identical (deterministic) output.

import { taskContractDigest } from './schema.mjs';

export const GRADER_VERSION = 'grader-v1';

function findTask(suite, taskId) {
  const task = suite.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  return task;
}

function executionCriterionBase(execution) {
  if (execution.status === 'incomplete') return { outcome: 'unknown', reason: 'execution_incomplete' };
  if (execution.status === 'failed') return { outcome: 'fail', reason: 'execution_failed' };
  return null; // status === 'completed'; caller evaluates the actual evidence.
}

function gradeArtifactCriterion(task, trace) {
  const base = executionCriterionBase(trace.execution);
  const changed = trace.artifacts.changedPaths, present = trace.artifacts.presentPaths;
  const outcome = base ?? (changed === null ? { outcome: 'unknown', reason: 'evidence_unavailable' }
    : !task.expectedEvidence.changedPaths.every(p => changed.includes(p)) ? { outcome: 'fail', reason: 'missing_evidence' }
    : present === null ? { outcome: 'unknown', reason: 'evidence_unavailable' }
    : task.expectedEvidence.changedPaths.every(p => present.includes(p)) ? { outcome: 'pass', reason: null }
    : { outcome: 'fail', reason: 'required_artifact_absent' });
  return {
    id: 'artifact', kind: 'artifact',
    description: `Required files reported changed: ${task.expectedEvidence.changedPaths.join(', ') || '(none required)'}.`,
    ...outcome,
  };
}

function gradeVerificationCriterion(task, trace) {
  const required = task.expectedEvidence.requiredVerifierIds;
  if (required.length === 0) return null;
  const description = `Verifiers [${required.join(', ')}] ran against the graded job, code digest and contract.`;
  const base = executionCriterionBase(trace.execution);
  if (base) return { id: 'verification', kind: 'verification', description, ...base };
  const verification = trace.verification;
  if (!verification) return { id: 'verification', kind: 'verification', description, outcome: 'fail', reason: 'missing_evidence' };
  if (verification.jobId !== trace.execution.jobId) return { id: 'verification', kind: 'verification', description, outcome: 'fail', reason: 'wrong_job' };
  if (verification.codeDigest !== trace.execution.codeDigest) return { id: 'verification', kind: 'verification', description, outcome: 'fail', reason: 'stale_evidence' };
  if (verification.contractDigest !== taskContractDigest(task)) return { id: 'verification', kind: 'verification', description, outcome: 'fail', reason: 'contract_mismatch' };
  if (!required.every(id => verification.verifierIds.includes(id))) return { id: 'verification', kind: 'verification', description, outcome: 'fail', reason: 'missing_verifier' };
  if (verification.status !== 'passed') return { id: 'verification', kind: 'verification', description, outcome: 'fail', reason: 'verification_failed' };
  return { id: 'verification', kind: 'verification', description, outcome: 'pass', reason: null };
}

function gradeReviewCriterion(task, trace) {
  if (!task.expectedEvidence.requiresReview) return null;
  const description = 'An independent review job approved this exact job, code digest and contract (not a different job or stale contract).';
  const base = executionCriterionBase(trace.execution);
  if (base) return { id: 'review', kind: 'review', description, ...base };
  const review = trace.review;
  if (!review) return { id: 'review', kind: 'review', description, outcome: 'fail', reason: 'missing_evidence' };
  if (review.jobId !== trace.execution.jobId) return { id: 'review', kind: 'review', description, outcome: 'fail', reason: 'wrong_job' };
  if (review.codeDigest !== trace.execution.codeDigest) return { id: 'review', kind: 'review', description, outcome: 'fail', reason: 'stale_evidence' };
  if (review.contractDigest !== taskContractDigest(task)) return { id: 'review', kind: 'review', description, outcome: 'fail', reason: 'contract_mismatch' };
  if (review.verdict !== 'approved') return { id: 'review', kind: 'review', description, outcome: 'fail', reason: 'review_rejected' };
  return { id: 'review', kind: 'review', description, outcome: 'pass', reason: null };
}

function gradeConstraintCriteria(task, trace) {
  return task.expectedEvidence.constraintEvidence.map(({ constraintId, path }) => {
    const description = `File "${path}" reported unchanged (file-preservation evidence only; this does not prove full API semantics for "${constraintId}").`;
    if (trace.retainedConstraintIds === null || trace.artifacts.unchangedPaths === null) return { id: `constraint:${constraintId}`, kind: 'constraint', description, outcome: 'unknown', reason: 'evidence_unavailable' };
    const retained = trace.retainedConstraintIds.includes(constraintId) && trace.artifacts.unchangedPaths.includes(path);
    return { id: `constraint:${constraintId}`, kind: 'constraint', description, outcome: retained ? 'pass' : 'fail', reason: retained ? null : 'missing_evidence' };
  });
}

function constraintRetentionFrom(task, constraintCriteria) {
  if (task.expectedEvidence.requiredConstraintIds.length === 0) return 'unknown';
  if (constraintCriteria.some(c => c.outcome === 'fail')) return 'lost';
  if (constraintCriteria.every(c => c.outcome === 'pass')) return 'retained';
  return 'unknown';
}

function gradeResume(task, trace) {
  if (!task.expectedEvidence.requiresResume) return { criterion: null, resumeCorrectness: 'unknown' };
  const description = 'Every resume request maps to exactly one job id (repeats of the same mapping are valid idempotency evidence).';
  if (trace.eventsTruncated) {
    return { criterion: { id: 'resume', kind: 'resume', description, outcome: 'unknown', reason: 'event_gap' }, resumeCorrectness: 'unknown' };
  }
  if (trace.resumeEvents.length === 0) {
    return { criterion: { id: 'resume', kind: 'resume', description, outcome: 'fail', reason: 'missing_evidence' }, resumeCorrectness: 'incorrect' };
  }
  const byRequest = new Map();
  for (const event of trace.resumeEvents) {
    if (!byRequest.has(event.requestId)) byRequest.set(event.requestId, new Set());
    byRequest.get(event.requestId).add(event.jobId);
  }
  const duplicated = [...byRequest.values()].some(jobIds => jobIds.size > 1);
  return duplicated
    ? { criterion: { id: 'resume', kind: 'resume', description, outcome: 'fail', reason: 'duplicate_job' }, resumeCorrectness: 'incorrect' }
    : { criterion: { id: 'resume', kind: 'resume', description, outcome: 'pass', reason: null }, resumeCorrectness: 'correct' };
}

function usageDimension(trace) {
  return {
    totalTokens: trace.usageAvailability.totalTokens === 'available' ? trace.usage.totalTokens : null,
    costUsd: trace.usageAvailability.costUsd === 'available' ? trace.usage.costUsd : null,
    observedResponses: trace.usage.observedResponses,
  };
}

export function gradeTask(task, trace) {
  if (task.id !== trace.taskId) throw new Error(`gradeTask: task id "${task.id}" does not match trace taskId "${trace.taskId}"`);
  const artifactCriterion = gradeArtifactCriterion(task, trace);
  const verificationCriterion = gradeVerificationCriterion(task, trace);
  const reviewCriterion = gradeReviewCriterion(task, trace);
  const constraintCriteria = gradeConstraintCriteria(task, trace);
  const { criterion: resumeCriterion, resumeCorrectness } = gradeResume(task, trace);
  const criteria = [artifactCriterion, verificationCriterion, reviewCriterion, ...constraintCriteria, resumeCriterion].filter(Boolean);
  const constraintRetention = constraintRetentionFrom(task, constraintCriteria);
  const resumeApplicable = task.expectedEvidence.requiresResume;
  const success = trace.execution.status === 'completed' &&
    criteria.filter(c => c.kind === 'artifact' || c.kind === 'verification' || c.kind === 'review').every(c => c.outcome === 'pass') &&
    (!task.expectedEvidence.requiredConstraintIds.length || constraintRetention === 'retained') &&
    (!resumeApplicable || resumeCorrectness === 'correct');
  return {
    taskId: task.id,
    criteria,
    taskSuccess: success,
    constraintApplicable: task.expectedEvidence.requiredConstraintIds.length > 0,
    resumeApplicable,
    constraintRetention,
    resumeCorrectness,
    latencyMs: trace.timing ? trace.timing.durationMs : null,
    usage: usageDimension(trace),
  };
}

function aggregateObserved(values) {
  const observed = values.filter(v => v !== null);
  return {
    value: observed.length ? observed.reduce((sum, v) => sum + v, 0) / observed.length : null,
    observedCount: observed.length,
    applicableCount: values.length,
    unknownCount: values.length - observed.length,
  };
}

export function gradeSuite({ suite, traces, selectedTaskIds }) {
  if (!Array.isArray(selectedTaskIds) || selectedTaskIds.length < 1 || selectedTaskIds.length > 64 ||
    new Set(selectedTaskIds).size !== selectedTaskIds.length || selectedTaskIds.some(id => !suite.tasks.some(task => task.id === id))) throw new Error('Invalid selected task IDs');
  if (!Array.isArray(traces) || traces.some(trace => !selectedTaskIds.includes(trace.taskId))) throw new Error('Trace outside selection');
  const byTaskId = new Map();
  for (const trace of traces) {
    if (byTaskId.has(trace.taskId)) throw new Error(`gradeSuite: duplicate trace for taskId "${trace.taskId}"`);
    byTaskId.set(trace.taskId, trace);
  }
  const perTask = selectedTaskIds.map(taskId => {
    const task = findTask(suite, taskId);
    const trace = byTaskId.get(taskId);
    if (!trace) {
      return {
        taskId, criteria: [], taskSuccess: false, reason: 'missing_outcome',
        constraintApplicable: task.expectedEvidence.requiredConstraintIds.length > 0,
        resumeApplicable: task.expectedEvidence.requiresResume,
        constraintRetention: 'unknown',
        resumeCorrectness: 'unknown',
        latencyMs: null, usage: { totalTokens: null, costUsd: null, observedResponses: 0 },
        hasTrace: false,
      };
    }
    return { ...gradeTask(task, trace), reason: null, hasTrace: true };
  });
  const total = selectedTaskIds.length;
  const passed = perTask.filter(item => item.taskSuccess).length;

  const retentionApplicable = selectedTaskIds.filter(id => findTask(suite, id).expectedEvidence.requiredConstraintIds.length > 0);
  const retentionFor = id => perTask.find(item => item.taskId === id).constraintRetention;
  const resumeApplicable = selectedTaskIds.filter(id => findTask(suite, id).expectedEvidence.requiresResume);
  const resumeFor = id => perTask.find(item => item.taskId === id).resumeCorrectness;

  return {
    graderVersion: GRADER_VERSION,
    selectedTaskIds: [...selectedTaskIds],
    taskSuccess: { passed, total, rate: total ? passed / total : null },
    constraintRetention: {
      retained: retentionApplicable.filter(id => retentionFor(id) === 'retained').length,
      lost: retentionApplicable.filter(id => retentionFor(id) === 'lost').length,
      unknown: retentionApplicable.filter(id => retentionFor(id) === 'unknown').length,
      applicable: retentionApplicable.length,
    },
    resumeCorrectness: {
      correct: resumeApplicable.filter(id => resumeFor(id) === 'correct').length,
      incorrect: resumeApplicable.filter(id => resumeFor(id) === 'incorrect').length,
      unknown: resumeApplicable.filter(id => resumeFor(id) === 'unknown').length,
      applicable: resumeApplicable.length,
    },
    latencyMs: aggregateObserved(perTask.map(item => item.latencyMs)),
    usage: {
      totalTokens: aggregateObserved(perTask.map(item => item.usage.totalTokens)),
      costUsd: aggregateObserved(perTask.map(item => item.usage.costUsd)),
    },
    perTask,
  };
}
