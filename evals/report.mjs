// Builds and writes a bounded, field-allowlisted evaluation report. The
// report never includes raw trace content, credentials, session bodies or
// tool output -- only the identity/provenance fields and the grader's own
// already-derived result object (gradeSuite output), which itself contains
// only controlled-vocabulary criteria/outcome/reason strings and counts.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ProvenanceError } from './errors.mjs';
import { GIT_SHA, CONFIG_FINGERPRINT_PATTERN } from './util.mjs';

const ORIGINS = new Set(['synthetic', 'live']);

function requireMatch(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

export function buildReport({ suite, graderVersion, selectedTaskIds, harnessCommit, taskBaseCommit, configFingerprint, origin, traces, result }) {
  requireMatch(harnessCommit, 'harnessCommit', GIT_SHA);
  requireMatch(taskBaseCommit, 'taskBaseCommit', GIT_SHA);
  requireMatch(configFingerprint, 'configFingerprint', CONFIG_FINGERPRINT_PATTERN);
  if (!ORIGINS.has(origin)) throw new Error(`Invalid origin: ${origin}`);
  for (const trace of traces) {
    if (trace.origin !== origin || trace.harnessCommit !== harnessCommit ||
      trace.taskBaseCommit !== taskBaseCommit || trace.configFingerprint !== configFingerprint) {
      throw new ProvenanceError(`Trace ${trace.taskId} provenance does not match the report's declared origin/harnessCommit/taskBaseCommit/configFingerprint`);
    }
  }
  return {
    reportVersion: 'v1',
    suiteVersion: suite.version,
    suiteDigest: suite.digest,
    graderVersion,
    origin,
    harnessCommit,
    taskBaseCommit,
    configFingerprint,
    selectedTaskIds: [...selectedTaskIds],
    result,
    ...(origin === 'synthetic' ? { note: 'Synthetic replay validates grader/harness consistency only; it is not a measure of model capability.' } : {}),
  };
}

export async function writeReport(destination, report) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('writeReport destination must be an absolute path');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  // O_EXCL ('wx') makes creation atomic and refuses to overwrite an existing report.
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
