import path from 'node:path';
import { createHash } from 'node:crypto';

const id = /^[a-z][a-z0-9_-]{0,47}$/;
const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
  value === value.normalize('NFC') && !/[\\\p{Cc}\p{Cf}]/u.test(value) && !path.posix.isAbsolute(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..' && !/^\.git$/i.test(part) && !/^\.pi-mcp(?:-|$)/i.test(part) && part === part.trimEnd());
const exact = (raw, fields) => { if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key))) throw new Error('Invalid acceptance contract'); };
const list = (values, valid, label) => {
  if (!Array.isArray(values) || values.length > 32 || values.some(value => !valid(value)) || new Set(values).size !== values.length) throw new Error(`Invalid ${label}`);
  return [...values].sort();
};
export function normalizeAcceptance(raw) {
  if (raw === undefined || raw === null) return null;
  exact(raw, ['version', 'required_verification_ids', 'required_artifact_paths', 'require_review']);
  if (raw.version !== 1 || raw.require_review !== undefined && typeof raw.require_review !== 'boolean') throw new Error('Invalid acceptance contract version or review flag');
  return { version: 1, required_verification_ids: list(raw.required_verification_ids ?? [], value => typeof value === 'string' && id.test(value), 'required verification IDs'),
    required_artifact_paths: list(raw.required_artifact_paths ?? [], safePath, 'required artifact paths'), require_review: raw.require_review === true };
}
export function inheritAcceptance(parent, raw) {
  const child = normalizeAcceptance(raw);
  if (!parent) return child;
  if (!child) return normalizeAcceptance(parent);
  return normalizeAcceptance({ version: 1,
    required_verification_ids: [...new Set([...parent.required_verification_ids, ...child.required_verification_ids])],
    required_artifact_paths: [...new Set([...parent.required_artifact_paths, ...child.required_artifact_paths])],
    require_review: parent.require_review || child.require_review });
}
export function contractDigest(contract) { return createHash('sha256').update(JSON.stringify(normalizeAcceptance(contract))).digest('hex'); }
export async function evaluateAcceptance(job, hasSourcePath) {
  const contract = normalizeAcceptance(job.acceptanceContract);
  if (!contract) return { status: 'not_requested' };
  const digest = contractDigest(contract);
  const evidence = { sourceJobId: job.id, inputSnapshotDigest: job.artifacts?.inputSnapshotDigest || null,
    contractDigest: digest, manifestSha256: job.artifacts?.manifestSha256 || null };
  if (job.status !== 'completed' || job.execution?.status !== 'passed' || !job.artifacts?.checkpointComplete || !evidence.inputSnapshotDigest || !evidence.manifestSha256) return { status: 'execution_incomplete', ...evidence };
  if (contract.required_verification_ids.some(id => !job.verificationIds?.includes(id) || job.verification?.status !== 'passed' || job.verification?.verifiedSnapshotDigest !== evidence.inputSnapshotDigest || !job.verification.commands?.some(item => item.id === id && item.status === 'passed'))) return { status: 'verification_incomplete', ...evidence };
  for (const rel of contract.required_artifact_paths) if (!await hasSourcePath(rel)) return { status: 'missing_artifacts', path: rel, ...evidence };
  if (contract.require_review) {
    const latest = (job.reviewAttestations || []).filter(item => item.authority === 'caller' &&
      ['sourceJobId', 'inputSnapshotDigest', 'contractDigest'].every(key => item[key] === evidence[key])).at(-1);
    if (latest?.verdict === 'rejected') return { status: 'review_rejected', ...evidence };
    if (latest?.verdict !== 'approved') return { status: 'pending_review', ...evidence };
  }
  return { status: 'accepted', ...evidence };
}
