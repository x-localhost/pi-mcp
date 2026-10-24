// Synthetic positive/negative replay fixture for grader validation only.
// This demonstrates each suite scenario's intended grading outcome; it says
// nothing about any real model's capability. The contractDigest fields are
// computed here from the real suite tasks via taskContractDigest, so this
// file -- not a hand-computed hash literal -- is the source of truth for
// "what a well-formed, matching contract digest looks like" in a fixture.

import { loadSuite } from '../suite.mjs';
import { taskContractDigest } from '../schema.mjs';

const HARNESS_COMMIT = '1'.repeat(40);
const TASK_BASE_COMMIT = '2'.repeat(40);
const CONFIG_FINGERPRINT = `sha256:${'3'.repeat(64)}`;
const RUN_ID = 'synthetic-baseline';

function hex(seed) {
  return seed.repeat(64).slice(0, 64);
}

function base(taskId, overrides) {
  return {
    taskId, runId: RUN_ID, origin: 'synthetic',
    harnessCommit: HARNESS_COMMIT, taskBaseCommit: TASK_BASE_COMMIT, configFingerprint: CONFIG_FINGERPRINT,
    execution: { jobId: `job-${taskId}`, status: 'completed', codeDigest: hex('a') },
    artifacts: { changedPaths: [], unchangedPaths: [] },
    verification: null,
    review: null,
    retainedConstraintIds: [],
    resumeEvents: [],
    eventsTruncated: false,
    timing: { durationMs: 4200 },
    usageAvailability: { totalTokens: 'available', costUsd: 'available' },
    usage: { totalTokens: 1200, costUsd: 0.02, observedResponses: 3 },
    ...overrides,
  };
}

export async function buildBaselineTraces() {
  const suite = await loadSuite();
  const byId = id => suite.tasks.find(task => task.id === id);
  const freshVerification = (task, { codeDigest, verifierIds }) => ({
    jobId: `job-${task.id}`, codeDigest, contractDigest: taskContractDigest(task), verifierIds, status: 'passed',
  });

  return [
    // successful_completion: everything matches, nothing stale, constraint retained.
    base('fix-null-check', (() => {
      const task = byId('fix-null-check');
      const codeDigest = hex('a');
      return {
        execution: { jobId: 'job-fix-null-check', status: 'completed', codeDigest },
        artifacts: { changedPaths: ['src/parser.mjs'], unchangedPaths: ['src/parser-api.mjs'] },
        verification: freshVerification(task, { codeDigest, verifierIds: ['lint'] }),
        retainedConstraintIds: ['preserve-public-api'],
      };
    })()),

    // false_completion: status says "completed" and verification even says
    // "passed", but no evidence the required file actually changed.
    base('false-claim-complete', (() => {
      const task = byId('false-claim-complete');
      const codeDigest = hex('b');
      return {
        execution: { jobId: 'job-false-claim-complete', status: 'completed', codeDigest },
        artifacts: { changedPaths: [], unchangedPaths: [] },
        verification: freshVerification(task, { codeDigest, verifierIds: ['lint'] }),
      };
    })()),

    // lost_constraint: retainedConstraintIds claims it, but the independent
    // unchangedPaths evidence does not confirm the file was left alone.
    base('preserve-auth-contract', (() => {
      const task = byId('preserve-auth-contract');
      const codeDigest = hex('c');
      return {
        execution: { jobId: 'job-preserve-auth-contract', status: 'completed', codeDigest },
        artifacts: { changedPaths: ['src/session-store.mjs'], unchangedPaths: [] },
        verification: freshVerification(task, { codeDigest, verifierIds: ['unit'] }),
        retainedConstraintIds: ['preserve-auth-contract'],
      };
    })()),

    // duplicate_resume: one request_id mapped to two different job ids.
    base('resume-after-timeout', {
      execution: { jobId: 'job-resume-after-timeout', status: 'completed', codeDigest: hex('d') },
      artifacts: { changedPaths: ['src/migration.mjs'], unchangedPaths: [] },
      resumeEvents: [
        { eventId: 'e1', requestId: 'r1', jobId: 'job-a' },
        { eventId: 'e2', requestId: 'r1', jobId: 'job-b' },
      ],
    }),

    // repeated_resume: the same request_id mapped to the same job id twice
    // -- valid idempotency evidence, not a failure.
    base('retry-flaky-build', {
      execution: { jobId: 'job-retry-flaky-build', status: 'completed', codeDigest: hex('e') },
      artifacts: { changedPaths: ['src/build.mjs'], unchangedPaths: [] },
      resumeEvents: [
        { eventId: 'e1', requestId: 'r1', jobId: 'job-x' },
        { eventId: 'e2', requestId: 'r1', jobId: 'job-x' },
      ],
    }),

    // stale_verification: verification ran against a different code digest.
    base('lint-clean-formatter', (() => {
      const task = byId('lint-clean-formatter');
      return {
        execution: { jobId: 'job-lint-clean-formatter', status: 'completed', codeDigest: hex('f') },
        artifacts: { changedPaths: ['src/formatter.mjs'], unchangedPaths: [] },
        verification: freshVerification(task, { codeDigest: hex('0'), verifierIds: ['lint'] }),
      };
    })()),

    // stale_review: verification is fresh and passes, but the review
    // attests to a different (stale) code digest.
    base('review-rate-limiter', (() => {
      const task = byId('review-rate-limiter');
      const codeDigest = hex('1');
      return {
        execution: { jobId: 'job-review-rate-limiter', status: 'completed', codeDigest },
        artifacts: { changedPaths: ['src/rate-limiter.mjs'], unchangedPaths: [] },
        verification: freshVerification(task, { codeDigest, verifierIds: ['unit'] }),
        review: { jobId: 'job-review-rate-limiter', reviewJobId: 'job-review-rate-limiter-review', codeDigest: hex('9'), contractDigest: taskContractDigest(task), verdict: 'approved' },
      };
    })()),

    // missing_outcome is intentionally omitted here: 'optional-telemetry-cleanup'
    // has no trace at all, demonstrating the missing-outcome scenario when
    // this fixture is replayed with the full suite selection.

    // unavailable_usage: execution and verification both succeed, but usage
    // measurement was genuinely unavailable -- must stay null, never 0.
    base('long-running-batch-job', (() => {
      const task = byId('long-running-batch-job');
      const codeDigest = hex('2');
      return {
        execution: { jobId: 'job-long-running-batch-job', status: 'completed', codeDigest },
        artifacts: { changedPaths: ['src/batch-job.mjs'], unchangedPaths: [] },
        verification: freshVerification(task, { codeDigest, verifierIds: ['lint'] }),
        timing: null,
        usageAvailability: { totalTokens: 'unavailable', costUsd: 'unavailable' },
        usage: { totalTokens: null, costUsd: null, observedResponses: 0 },
      };
    })()),

    // event_gap_resume: resume was required, but the event history is
    // explicitly flagged as truncated -- correctness is unknown, not assumed.
    base('resume-across-session-gap', {
      execution: { jobId: 'job-resume-across-session-gap', status: 'completed', codeDigest: hex('4') },
      artifacts: { changedPaths: ['src/deploy.mjs'], unchangedPaths: [] },
      resumeEvents: [],
      eventsTruncated: true,
    }),
  ];
}

export const traces = await buildBaselineTraces();
