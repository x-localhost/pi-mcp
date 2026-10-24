import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAcceptance, inheritAcceptance, evaluateAcceptance, contractDigest } from '../src/acceptance.mjs';

test('acceptance contract is strict, canonical, and monotone across continuations', () => {
  const parent = normalizeAcceptance({ version: 1, required_verification_ids: ['lint'], required_artifact_paths: ['src/a.mjs'], require_review: true });
  assert.equal(contractDigest(parent), contractDigest(normalizeAcceptance({ require_review: true, required_artifact_paths: ['src/a.mjs'], required_verification_ids: ['lint'], version: 1 })));
  assert.deepEqual(inheritAcceptance(parent, undefined), parent);
  assert.deepEqual(inheritAcceptance(parent, { version: 1, required_verification_ids: [], required_artifact_paths: [], require_review: false }), parent);
  assert.throws(() => normalizeAcceptance({ version: 2, required_verification_ids: [] }));
  assert.throws(() => normalizeAcceptance({ version: 1, required_artifact_paths: ['../outside'] }));
  assert.throws(() => normalizeAcceptance({ version: 1, extra: true }));
});

test('acceptance needs selected verified evidence, exact source files, and explicit matching caller attestation', async () => {
  const contract = normalizeAcceptance({ version: 1, required_verification_ids: ['lint'], required_artifact_paths: ['src/a.mjs'], require_review: true });
  const job = { id: 'task-123', status: 'completed', execution: { status: 'passed' }, verificationIds: ['lint'], verification: { status: 'passed', verifiedSnapshotDigest: 'snapshot', commands: [{ id: 'lint', status: 'passed' }] }, artifacts: { checkpointComplete: true, inputSnapshotDigest: 'snapshot', manifestSha256: 'manifest' }, acceptanceContract: contract };
  const sourcePath = async path => path === 'src/a.mjs';
  assert.equal((await evaluateAcceptance(job, sourcePath)).status, 'pending_review');
  const bad = { authority: 'caller', sourceJobId: job.id, inputSnapshotDigest: 'stale', contractDigest: contractDigest(contract), manifestSha256: 'manifest', verdict: 'approved' };
  assert.equal((await evaluateAcceptance({ ...job, reviewAttestations: [bad] }, sourcePath)).status, 'pending_review');
  const good = { ...bad, inputSnapshotDigest: 'snapshot' };
  assert.equal((await evaluateAcceptance({ ...job, reviewAttestations: [good] }, sourcePath)).status, 'accepted');
  assert.equal((await evaluateAcceptance({ ...job, reviewAttestations: [good, { ...good, verdict: 'rejected' }] }, sourcePath)).status, 'review_rejected');
  assert.equal((await evaluateAcceptance({ ...job, reviewAttestations: [good], artifacts: { ...job.artifacts, manifestSha256: 'changed' } }, sourcePath)).status, 'accepted');
  assert.equal((await evaluateAcceptance({ ...job, reviewAttestations: [good] }, async () => false)).status, 'missing_artifacts');
  assert.equal((await evaluateAcceptance({ ...job, acceptanceContract: null }, sourcePath)).status, 'not_requested');
});
