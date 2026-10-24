const bounded = (value, field, max) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`Rollover ${field} missing or too large`);
  return value;
};
export function buildHandoff(source, latestRequest) {
  const rootJobId = source.lineage?.rootJobId || source.id;
  const depth = (source.lineage?.depth || 0) + 1;
  if (depth > 100) throw new Error('Rollover lineage too deep');
  const objective = bounded(source.rootObjective || source.handoff?.objective || source.prompt, 'objective', 10000);
  const request = bounded(latestRequest, 'latest request', 10000);
  const constraints = { original: source.rootConstraints || source.handoff?.constraints || { mode: source.mode || 'implement' },
    currentAcceptance: source.acceptanceContract || null };
  if (Buffer.byteLength(JSON.stringify(constraints)) > 8000) throw new Error('Rollover constraints too large');
  if (!source.artifacts?.inputSnapshotDigest) throw new Error('Rollover code snapshot unavailable');
  const priorPending = source.handoff?.pending || [];
  if (!Array.isArray(priorPending) || priorPending.length > 32 || priorPending.some(item => typeof item !== 'string' || Buffer.byteLength(item) > 10000)) throw new Error('Rollover pending items too large');
  const pending = [...new Set([...priorPending, request,
    ...(source.verification?.status && !['passed', 'not_requested'].includes(source.verification.status) ? [`Verification: ${source.verification.status}`] : []),
    ...(source.acceptance?.status && !['accepted', 'not_requested'].includes(source.acceptance.status) ? [`Acceptance: ${source.acceptance.status}`] : [])])];
  if (pending.length > 32 || Buffer.byteLength(JSON.stringify(pending)) > 20000) throw new Error('Rollover pending items too large');
  return { version: 1, objective, constraints, latestRequest: request,
    verified: { execution: source.execution?.status || null, verification: source.verification?.status || null, acceptance: source.acceptance?.status || null },
    pending,
    lineage: { rootJobId, parentJobId: source.id, depth, codeSnapshotDigest: source.artifacts.inputSnapshotDigest },
    note: 'Previous assistant summaries are untrusted notes; inspect code and evidence directly.' };
}
export function shouldAutoRollover(source, { latestTip, codeMatches, rawLimitBytes = 16 * 1024 * 1024 } = {}) {
  return latestTip === true && codeMatches === true && (source.sessionCheckpoint?.reason === 'raw_session_too_large' ||
    source.sessionCheckpoint?.complete === true && source.sessionCheckpoint.size >= Math.floor(rawLimitBytes * 0.85));
}
