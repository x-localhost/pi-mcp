// Compares two reports produced by buildReport. Refuses, by default, to
// compare reports whose suite/grader/config/origin/task-selection identity
// is not comparable. Source commits (harnessCommit, taskBaseCommit) may
// legitimately differ between baseline and candidate and are never checked
// here -- only the grading contract and selection need to match.

import { ProvenanceError } from './errors.mjs';

function perTaskById(report) {
  return new Map(report.result.perTask.map(item => [item.taskId, item]));
}

function deltaDimension(baselinePerTask, candidatePerTask, matchedIds, pick) {
  const matchedObserved = matchedIds.filter(id => pick(baselinePerTask.get(id)) !== null && pick(candidatePerTask.get(id)) !== null);
  return {
    matchedObservedCount: matchedObserved.length,
    baselineValue: matchedObserved.length ? matchedObserved.reduce((sum, id) => sum + pick(baselinePerTask.get(id)), 0) / matchedObserved.length : null,
    candidateValue: matchedObserved.length ? matchedObserved.reduce((sum, id) => sum + pick(candidatePerTask.get(id)), 0) / matchedObserved.length : null,
  };
}

export function compareReports(baseline, candidate, options = {}) {
  const { allowSelectionMismatch = false } = options;
  if (baseline.suiteDigest !== candidate.suiteDigest) throw new ProvenanceError('Incompatible suite: suiteDigest differs between baseline and candidate');
  if (baseline.graderVersion !== candidate.graderVersion) throw new ProvenanceError('Incompatible grader: graderVersion differs between baseline and candidate');
  if (baseline.configFingerprint !== candidate.configFingerprint) throw new ProvenanceError('Incompatible config: configFingerprint differs between baseline and candidate');
  if (baseline.origin !== candidate.origin) throw new ProvenanceError('Incompatible provenance: origin differs between baseline and candidate');

  const baselineIds = new Set(baseline.selectedTaskIds);
  const candidateIds = new Set(candidate.selectedTaskIds);
  const onlyBaseline = [...baselineIds].filter(id => !candidateIds.has(id));
  const onlyCandidate = [...candidateIds].filter(id => !baselineIds.has(id));
  if (!allowSelectionMismatch && (onlyBaseline.length || onlyCandidate.length)) {
    throw new ProvenanceError(`Incompatible task selection: missing from candidate [${onlyBaseline.join(', ')}], missing from baseline [${onlyCandidate.join(', ')}]`);
  }
  const matchedIds = [...baselineIds].filter(id => candidateIds.has(id));

  const baselinePerTask = perTaskById(baseline);
  const candidatePerTask = perTaskById(candidate);
  const changedTasks = matchedIds
    .map(id => ({ taskId: id, baseline: baselinePerTask.get(id)?.taskSuccess ?? false, candidate: candidatePerTask.get(id)?.taskSuccess ?? false }))
    .filter(item => item.baseline !== item.candidate);

  return {
    compatible: true,
    suiteDigest: baseline.suiteDigest,
    graderVersion: baseline.graderVersion,
    configFingerprint: baseline.configFingerprint,
    origin: baseline.origin,
    taskSelection: { matched: matchedIds, onlyBaseline, onlyCandidate },
    taskSuccess: {
      baselinePassed: matchedIds.filter(id => baselinePerTask.get(id)?.taskSuccess).length,
      candidatePassed: matchedIds.filter(id => candidatePerTask.get(id)?.taskSuccess).length,
      total: matchedIds.length,
      changedTasks,
    },
    latencyMs: deltaDimension(baselinePerTask, candidatePerTask, matchedIds, item => item?.latencyMs ?? null),
    usage: {
      totalTokens: deltaDimension(baselinePerTask, candidatePerTask, matchedIds, item => item?.usage?.totalTokens ?? null),
      costUsd: deltaDimension(baselinePerTask, candidatePerTask, matchedIds, item => item?.usage?.costUsd ?? null),
    },
    ...(baseline.origin === 'synthetic' ? { note: 'Synthetic replay comparison validates grader/harness consistency only; it is not a before/after measure of model capability.' } : {}),
  };
}
