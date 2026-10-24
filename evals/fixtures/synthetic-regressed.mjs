// Synthetic "candidate" fixture for exercising the `compare` CLI against the
// synthetic-baseline fixture. It takes the baseline traces and flips one
// previously-successful task ("fix-null-check") into a false completion, so
// that `compare` has a real, deterministic regression to report. This is a
// grader/CLI validation fixture only, not a measure of any model's
// capability.

import { buildBaselineTraces } from './synthetic-baseline.mjs';

export async function buildRegressedTraces() {
  const baseline = await buildBaselineTraces();
  return baseline.map(trace => trace.taskId === 'fix-null-check'
    ? { ...trace, runId: 'synthetic-regressed', artifacts: { changedPaths: [], unchangedPaths: trace.artifacts.unchangedPaths } }
    : { ...trace, runId: 'synthetic-regressed' });
}

export const traces = await buildRegressedTraces();
