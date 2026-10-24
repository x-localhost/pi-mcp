import { ProvenanceError } from './errors.mjs';
import { validateReport } from './report.mjs';
function byId(report) { return new Map(report.result.perTask.map(item => [item.taskId,item])); }
function dimension(base, candidate, ids, get) {
  const matched = ids.filter(id => get(base.get(id)) !== null && get(candidate.get(id)) !== null);
  const mean = source => matched.length ? matched.reduce((sum,id) => sum + get(source.get(id)),0) / matched.length : null;
  const baselineValue = mean(base), candidateValue = mean(candidate);
  return { matchedObservedCount: matched.length, baselineValue, candidateValue,
    candidateMinusBaseline: matched.length ? candidateValue - baselineValue : null };
}
export function compareReports(baselineInput, candidateInput, options = {}) {
  const baseline = validateReport(baselineInput), candidate = validateReport(candidateInput);
  const { allowSelectionMismatch = false, allowObservedMismatch = false } = options;
  if (typeof allowSelectionMismatch !== 'boolean' || typeof allowObservedMismatch !== 'boolean' ||
    Object.keys(options).some(key => !['allowSelectionMismatch','allowObservedMismatch'].includes(key))) throw new Error('Invalid comparison options');
  for (const field of ['suiteVersion','suiteDigest','graderVersion','configFingerprint','origin']) {
    if (baseline[field] !== candidate[field]) throw new ProvenanceError('Incompatible ' + field);
  }
  const first = new Set(baseline.selectedTaskIds), second = new Set(candidate.selectedTaskIds);
  const onlyBaseline = [...first].filter(id => !second.has(id)), onlyCandidate = [...second].filter(id => !first.has(id));
  if (!allowSelectionMismatch && (onlyBaseline.length || onlyCandidate.length)) throw new ProvenanceError('Incompatible task selection: ' + [...onlyBaseline,...onlyCandidate].join(', '));
  const aObserved = new Set(baseline.observedTaskIds), bObserved = new Set(candidate.observedTaskIds);
  const observedOnlyBaseline = [...aObserved].filter(id => !bObserved.has(id));
  const observedOnlyCandidate = [...bObserved].filter(id => !aObserved.has(id));
  if (!allowObservedMismatch && (observedOnlyBaseline.length || observedOnlyCandidate.length)) throw new ProvenanceError('Incompatible observed coverage');
  const matched = [...first].filter(id => second.has(id));
  const a = byId(baseline), b = byId(candidate);
  return { compatible: true, suiteDigest: baseline.suiteDigest, graderVersion: baseline.graderVersion,
    configFingerprint: baseline.configFingerprint, origin: baseline.origin,
    taskSelection: { matched, onlyBaseline, onlyCandidate },
    observedCoverage: { matched: [...aObserved].filter(id => bObserved.has(id)), onlyBaseline: observedOnlyBaseline, onlyCandidate: observedOnlyCandidate },
    taskSuccess: { baselinePassed: matched.filter(id => a.get(id).taskSuccess).length,
      candidatePassed: matched.filter(id => b.get(id).taskSuccess).length, total: matched.length,
      changedTasks: matched.filter(id => a.get(id).taskSuccess !== b.get(id).taskSuccess)
        .map(taskId => ({ taskId, baseline: a.get(taskId).taskSuccess, candidate: b.get(taskId).taskSuccess })) },
    latencyMs: dimension(a,b,matched,item => item.latencyMs),
    usage: { totalTokens: dimension(a,b,matched,item => item.usage.totalTokens),
      costUsd: dimension(a,b,matched,item => item.usage.costUsd) },
    ...(baseline.origin === 'synthetic' ? { note: 'Synthetic replay comparison checks grader consistency only; it does not measure model capability.' } : {}) };
}
