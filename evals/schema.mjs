// Strict bounded schema for the evaluation suite's task and trace/outcome
// records. See docs/harness-evals.md for the full field reference.
//
// Design rule: a record that is structurally well-formed but describes a
// negative outcome (false completion, stale evidence, a duplicated resume
// mapping, ...) must parse successfully here. Only genuinely malformed input
// -- unknown fields, wrong types, out-of-range values, bad identifiers,
// duplicate record IDs, unbounded arrays, internally contradictory
// usage/availability pairs, or an unknown constraint ID -- is rejected with
// SchemaError. Grading negative outcomes happens later, in grader.mjs.

import { SchemaError } from './errors.mjs';
import { HEX64, GIT_SHA, CONFIG_FINGERPRINT_PATTERN, sha256Hex, stableStringify } from './util.mjs';
import { normalizeAcceptance, contractDigest } from '../src/acceptance.mjs';

const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const RUN_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const SCENARIOS = new Set([
  'successful_completion', 'false_completion', 'lost_constraint', 'duplicate_resume',
  'repeated_resume', 'stale_verification', 'stale_review', 'missing_outcome',
  'unavailable_usage', 'event_gap_resume',
]);
const EXECUTION_STATUSES = new Set(['completed', 'failed', 'incomplete']);
const VERIFICATION_STATUSES = new Set(['passed', 'failed']);
const REVIEW_VERDICTS = new Set(['approved', 'rejected']);
const AVAILABILITY = new Set(['available', 'unavailable']);
const ORIGINS = new Set(['synthetic', 'live']);
const MAX_PATHS = 64;
const MAX_IDS = 16;
const MAX_RESUME_EVENTS = 64;
const MAX_BATCH = 64;
const MAX_STRING = 2000;
const CRITERION_KINDS = new Set(['artifact', 'verification', 'review', 'resume', 'constraint']);

function fail(message) {
  throw new SchemaError(message);
}
function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${name}: expected object`);
  return value;
}
function allowKeys(value, name, allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown field ${name}.${key}`);
}
function requireString(value, name, { pattern, max = MAX_STRING } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(`Invalid ${name}`);
  if (pattern && !pattern.test(value)) fail(`Invalid ${name}`);
  return value;
}
function requireHex64(value, name) {
  return requireString(value, name, { pattern: HEX64, max: 64 });
}
function requireBoolean(value, name) {
  if (typeof value !== 'boolean') fail(`Invalid ${name}: expected boolean`);
  return value;
}
function requireEnum(value, name, allowed) {
  if (!allowed.has(value)) fail(`Invalid ${name}: ${JSON.stringify(value)}`);
  return value;
}
function requireArray(value, name, max) {
  if (!Array.isArray(value) || value.length > max) fail(`Invalid ${name}: expected array of at most ${max} entries`);
  return value;
}
function requireUniqueStringArray(value, name, { max, itemMax = 300, pattern } = {}) {
  requireArray(value, name, max);
  for (const item of value) requireString(item, `${name}[]`, { max: itemMax, pattern });
  if (new Set(value).size !== value.length) fail(`Duplicate entries in ${name}`);
  return value;
}
function requireFiniteNumber(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}
function requireNonNegativeInteger(value, name, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < 0 || value > max) fail(`Invalid ${name}`);
  return value;
}

export function parseTask(raw) {
  requireObject(raw, 'task');
  allowKeys(raw, 'task', ['id', 'scenario', 'prompt', 'criteria', 'expectedEvidence']);
  const id = requireString(raw.id, 'task.id', { pattern: ID_PATTERN, max: 64 });
  const scenario = requireEnum(raw.scenario, 'task.scenario', SCENARIOS);
  const prompt = requireString(raw.prompt, 'task.prompt', { max: 4000 });
  const criteria = requireArray(raw.criteria, 'task.criteria', 16).map((entry, index) => {
    requireObject(entry, `task.criteria[${index}]`);
    allowKeys(entry, `task.criteria[${index}]`, ['id', 'kind', 'description']);
    return {
      id: requireString(entry.id, `task.criteria[${index}].id`, { max: 64 }),
      kind: requireEnum(entry.kind, `task.criteria[${index}].kind`, CRITERION_KINDS),
      description: requireString(entry.description, `task.criteria[${index}].description`, { max: 400 }),
    };
  });
  if (new Set(criteria.map(entry => entry.id)).size !== criteria.length) fail('Duplicate task.criteria id');
  requireObject(raw.expectedEvidence, 'task.expectedEvidence');
  allowKeys(raw.expectedEvidence, 'task.expectedEvidence', [
    'changedPaths', 'requiredVerifierIds', 'requiresReview', 'requiresResume',
    'requiredConstraintIds', 'constraintEvidence',
  ]);
  const changedPaths = requireUniqueStringArray(raw.expectedEvidence.changedPaths, 'task.expectedEvidence.changedPaths', { max: MAX_PATHS });
  const requiredVerifierIds = requireUniqueStringArray(raw.expectedEvidence.requiredVerifierIds, 'task.expectedEvidence.requiredVerifierIds', { max: MAX_IDS, pattern: ID_PATTERN });
  const requiresReview = requireBoolean(raw.expectedEvidence.requiresReview, 'task.expectedEvidence.requiresReview');
  const requiresResume = requireBoolean(raw.expectedEvidence.requiresResume, 'task.expectedEvidence.requiresResume');
  const requiredConstraintIds = requireUniqueStringArray(raw.expectedEvidence.requiredConstraintIds, 'task.expectedEvidence.requiredConstraintIds', { max: MAX_IDS, pattern: ID_PATTERN });
  const constraintEvidence = requireArray(raw.expectedEvidence.constraintEvidence, 'task.expectedEvidence.constraintEvidence', MAX_IDS).map((entry, index) => {
    requireObject(entry, `task.expectedEvidence.constraintEvidence[${index}]`);
    allowKeys(entry, `task.expectedEvidence.constraintEvidence[${index}]`, ['constraintId', 'path']);
    return {
      constraintId: requireString(entry.constraintId, `task.expectedEvidence.constraintEvidence[${index}].constraintId`, { pattern: ID_PATTERN, max: 64 }),
      path: requireString(entry.path, `task.expectedEvidence.constraintEvidence[${index}].path`, { max: 300 }),
    };
  });
  // Every required constraint ID must have exactly one evidence predicate,
  // and every evidence predicate must reference a required constraint ID --
  // a dangling or conflicting mapping is malformed, not a grading outcome.
  const evidenceIds = constraintEvidence.map(entry => entry.constraintId);
  if (new Set(evidenceIds).size !== evidenceIds.length) fail('Duplicate constraintEvidence entries for the same constraintId');
  for (const constraintId of requiredConstraintIds) if (!evidenceIds.includes(constraintId)) fail(`Missing constraintEvidence for required constraint "${constraintId}"`);
  for (const constraintId of evidenceIds) if (!requiredConstraintIds.includes(constraintId)) fail(`constraintEvidence references constraint "${constraintId}" that is not required`);
  const expectedCriteria = new Map([['artifact', 'artifact']]);
  if (requiredVerifierIds.length) expectedCriteria.set('verification', 'verification');
  if (requiresReview) expectedCriteria.set('review', 'review');
  if (requiresResume) expectedCriteria.set('resume', 'resume');
  for (const constraintId of requiredConstraintIds) expectedCriteria.set(`constraint:${constraintId}`, 'constraint');
  if (criteria.some(entry => expectedCriteria.get(entry.id) !== entry.kind) || criteria.length > expectedCriteria.size) fail('Unsupported task criterion');
  try {
    normalizeAcceptance({ version: 1, required_verification_ids: requiredVerifierIds, required_artifact_paths: changedPaths, require_review: requiresReview });
    for (const item of constraintEvidence) normalizeAcceptance({ version: 1, required_artifact_paths: [item.path] });
  } catch { fail('Invalid task evidence path or runtime acceptance contract'); }
  return { id, scenario, prompt, criteria, expectedEvidence: { changedPaths, requiredVerifierIds, requiresReview, requiresResume, requiredConstraintIds, constraintEvidence } };
}

// The grader's own canonical contract digest for a task, computed only from
// the task's own suite-owned fields. Never compared against another
// self-reported value; a trace's claimed contractDigest is compared against
// this, independently recomputed, value.
export function taskContractDigest(task) {
  return contractDigest({ version: 1, required_verification_ids: task.expectedEvidence.requiredVerifierIds,
    required_artifact_paths: task.expectedEvidence.changedPaths, require_review: task.expectedEvidence.requiresReview });
}

export function taskContentDigest(task) {
  return sha256Hex(stableStringify(task));
}

function parseExecution(raw) {
  requireObject(raw, 'trace.execution');
  allowKeys(raw, 'trace.execution', ['jobId', 'status', 'codeDigest']);
  const jobId = requireString(raw.jobId, 'trace.execution.jobId', { pattern: RUN_TOKEN_PATTERN, max: 80 });
  const status = requireEnum(raw.status, 'trace.execution.status', EXECUTION_STATUSES);
  if (status === 'incomplete') {
    if (raw.codeDigest !== null) fail('trace.execution.codeDigest must be null when status is "incomplete"');
    return { jobId, status, codeDigest: null };
  }
  return { jobId, status, codeDigest: requireHex64(raw.codeDigest, 'trace.execution.codeDigest') };
}

function parseArtifacts(raw) {
  requireObject(raw, 'trace.artifacts');
  allowKeys(raw, 'trace.artifacts', ['changedPaths', 'unchangedPaths']);
  const changedPaths = raw.changedPaths === null ? null : requireUniqueStringArray(raw.changedPaths, 'trace.artifacts.changedPaths', { max: MAX_PATHS });
  const unchangedPaths = raw.unchangedPaths === null ? null : requireUniqueStringArray(raw.unchangedPaths, 'trace.artifacts.unchangedPaths', { max: MAX_PATHS });
  if (changedPaths && unchangedPaths && changedPaths.some(item => unchangedPaths.includes(item))) fail('Contradictory changed/unchanged path evidence');
  return { changedPaths, unchangedPaths };
}

function parseVerification(raw) {
  if (raw === null) return null;
  requireObject(raw, 'trace.verification');
  allowKeys(raw, 'trace.verification', ['jobId', 'codeDigest', 'contractDigest', 'verifierIds', 'status']);
  return {
    jobId: requireString(raw.jobId, 'trace.verification.jobId', { pattern: RUN_TOKEN_PATTERN, max: 80 }),
    codeDigest: requireHex64(raw.codeDigest, 'trace.verification.codeDigest'),
    contractDigest: requireHex64(raw.contractDigest, 'trace.verification.contractDigest'),
    verifierIds: requireUniqueStringArray(raw.verifierIds, 'trace.verification.verifierIds', { max: MAX_IDS, pattern: ID_PATTERN }),
    status: requireEnum(raw.status, 'trace.verification.status', VERIFICATION_STATUSES),
  };
}

function parseReview(raw) {
  if (raw === null) return null;
  requireObject(raw, 'trace.review');
  allowKeys(raw, 'trace.review', ['jobId', 'reviewJobId', 'codeDigest', 'contractDigest', 'verdict']);
  if (raw.jobId === raw.reviewJobId) fail('Independent review requires a different reviewJobId');
  return {
    jobId: requireString(raw.jobId, 'trace.review.jobId', { pattern: RUN_TOKEN_PATTERN, max: 80 }),
    reviewJobId: requireString(raw.reviewJobId, 'trace.review.reviewJobId', { pattern: RUN_TOKEN_PATTERN, max: 80 }),
    codeDigest: requireHex64(raw.codeDigest, 'trace.review.codeDigest'),
    contractDigest: requireHex64(raw.contractDigest, 'trace.review.contractDigest'),
    verdict: requireEnum(raw.verdict, 'trace.review.verdict', REVIEW_VERDICTS),
  };
}

function parseResumeEvents(raw) {
  const events = requireArray(raw, 'trace.resumeEvents', MAX_RESUME_EVENTS).map((entry, index) => {
    requireObject(entry, `trace.resumeEvents[${index}]`);
    allowKeys(entry, `trace.resumeEvents[${index}]`, ['eventId', 'requestId', 'jobId']);
    return {
      eventId: requireString(entry.eventId, `trace.resumeEvents[${index}].eventId`, { pattern: RUN_TOKEN_PATTERN, max: 80 }),
      requestId: requireString(entry.requestId, `trace.resumeEvents[${index}].requestId`, { pattern: RUN_TOKEN_PATTERN, max: 80 }),
      jobId: requireString(entry.jobId, `trace.resumeEvents[${index}].jobId`, { pattern: RUN_TOKEN_PATTERN, max: 80 }),
    };
  });
  const eventIds = events.map(event => event.eventId);
  if (new Set(eventIds).size !== eventIds.length) fail('Duplicate resumeEvents[].eventId');
  return events;
}

function parseUsage(raw, availability) {
  requireObject(raw, 'trace.usage');
  allowKeys(raw, 'trace.usage', ['totalTokens', 'costUsd', 'observedResponses']);
  const observedResponses = requireNonNegativeInteger(raw.observedResponses, 'trace.usage.observedResponses', { max: 100000 });
  const dimension = (value, name, fieldAvailability, max) => {
    if (fieldAvailability === 'unavailable') {
      if (value !== null) fail(`${name} must be null when its availability is "unavailable"`);
      return null;
    }
    if (observedResponses < 1) fail(`${name} cannot be "available" with zero observedResponses`);
    return requireFiniteNumber(value, name, { min: 0, max });
  };
  return {
    totalTokens: dimension(raw.totalTokens, 'trace.usage.totalTokens', availability.totalTokens, 50_000_000),
    costUsd: dimension(raw.costUsd, 'trace.usage.costUsd', availability.costUsd, 1_000_000),
    observedResponses,
  };
}

function parseUsageAvailability(raw) {
  requireObject(raw, 'trace.usageAvailability');
  allowKeys(raw, 'trace.usageAvailability', ['totalTokens', 'costUsd']);
  return {
    totalTokens: requireEnum(raw.totalTokens, 'trace.usageAvailability.totalTokens', AVAILABILITY),
    costUsd: requireEnum(raw.costUsd, 'trace.usageAvailability.costUsd', AVAILABILITY),
  };
}

export function parseTrace(raw) {
  requireObject(raw, 'trace');
  allowKeys(raw, 'trace', [
    'taskId', 'runId', 'origin', 'harnessCommit', 'taskBaseCommit', 'configFingerprint',
    'execution', 'artifacts', 'verification', 'review', 'retainedConstraintIds',
    'resumeEvents', 'eventsTruncated', 'timing', 'usageAvailability', 'usage',
  ]);
  const taskId = requireString(raw.taskId, 'trace.taskId', { pattern: ID_PATTERN, max: 64 });
  const runId = requireString(raw.runId, 'trace.runId', { pattern: RUN_TOKEN_PATTERN, max: 80 });
  const origin = requireEnum(raw.origin, 'trace.origin', ORIGINS);
  const harnessCommit = requireString(raw.harnessCommit, 'trace.harnessCommit', { pattern: GIT_SHA, max: 40 });
  const taskBaseCommit = requireString(raw.taskBaseCommit, 'trace.taskBaseCommit', { pattern: GIT_SHA, max: 40 });
  const configFingerprint = requireString(raw.configFingerprint, 'trace.configFingerprint', { pattern: CONFIG_FINGERPRINT_PATTERN, max: 71 });
  const execution = parseExecution(raw.execution);
  const artifacts = parseArtifacts(raw.artifacts);
  const verification = parseVerification(raw.verification === undefined ? null : raw.verification);
  const review = parseReview(raw.review === undefined ? null : raw.review);
  const retainedConstraintIds = raw.retainedConstraintIds === null ? null :
    requireUniqueStringArray(raw.retainedConstraintIds, 'trace.retainedConstraintIds', { max: MAX_IDS, pattern: ID_PATTERN });
  const resumeEvents = parseResumeEvents(raw.resumeEvents);
  const eventsTruncated = requireBoolean(raw.eventsTruncated, 'trace.eventsTruncated');
  let timing = null;
  if (raw.timing !== null) {
    requireObject(raw.timing, 'trace.timing');
    allowKeys(raw.timing, 'trace.timing', ['durationMs']);
    timing = { durationMs: requireNonNegativeInteger(raw.timing.durationMs, 'trace.timing.durationMs', { max: 86_400_000 }) };
  }
  const usageAvailability = parseUsageAvailability(raw.usageAvailability);
  const usage = parseUsage(raw.usage, usageAvailability);
  return {
    taskId, runId, origin, harnessCommit, taskBaseCommit, configFingerprint,
    execution, artifacts, verification, review, retainedConstraintIds,
    resumeEvents, eventsTruncated, timing, usageAvailability, usage,
  };
}

export function parseTraceBatch(rawArray) {
  if (!Array.isArray(rawArray) || rawArray.length > MAX_BATCH) fail(`Invalid trace batch: expected array of at most ${MAX_BATCH} entries`);
  const traces = rawArray.map(parseTrace);
  const taskIds = traces.map(trace => trace.taskId);
  if (new Set(taskIds).size !== taskIds.length) fail('Duplicate taskId within a trace batch');
  if (traces.length > 0) {
    const [first] = traces;
    for (const trace of traces) {
      if (trace.runId !== first.runId || trace.origin !== first.origin || trace.harnessCommit !== first.harnessCommit ||
        trace.taskBaseCommit !== first.taskBaseCommit || trace.configFingerprint !== first.configFingerprint) {
        fail('Conflicting run identity within a trace batch: all records in one batch must share runId, origin, harnessCommit, taskBaseCommit and configFingerprint');
      }
    }
  }
  return traces;
}
