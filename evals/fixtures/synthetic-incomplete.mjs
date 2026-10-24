// Versioned synthetic incomplete execution fixture for replay coverage.
import { traces as baseline } from './synthetic-baseline.mjs';

export const traces = baseline.map((trace, index) => index === 0 ? {
  ...trace, runId: 'synthetic-incomplete',
  execution: { jobId: trace.execution.jobId, status: 'incomplete', codeDigest: null },
  artifacts: { changedPaths: null, presentPaths: null, unchangedPaths: null },
  verification: null, review: null, retainedConstraintIds: null,
  timing: null,
} : { ...trace, runId: 'synthetic-incomplete' });
