import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoff, shouldAutoRollover } from '../src/session-transition.mjs';

test('rollover handoff preserves mandatory fields without truncation', () => {
  const source = { id: 'task-source', title: 'Implement feature', prompt: 'Original objective', artifacts: { inputSnapshotDigest: 'abc' }, acceptanceContract: null, verification: { status: 'passed' }, lineage: { rootJobId: 'task-source', depth: 0 } };
  const handoff = buildHandoff(source, 'Next request');
  assert.equal(handoff.objective, 'Original objective');
  assert.equal(handoff.latestRequest, 'Next request');
  assert.deepEqual(handoff.lineage, { rootJobId: 'task-source', parentJobId: 'task-source', depth: 1, codeSnapshotDigest: 'abc' });
  assert.deepEqual(buildHandoff({ ...source, handoff: { pending: ['Existing unresolved item'] } }, 'Next request').pending, ['Existing unresolved item', 'Next request']);
  assert.throws(() => buildHandoff({ ...source, prompt: 'x'.repeat(10001) }, 'Next request'), /too large/);
});

test('auto rollover applies only to latest matching code tip near raw limit', () => {
  const source = { id: 'task-source', sessionCheckpoint: { complete: true, size: 15 * 1024 * 1024 }, artifacts: { inputSnapshotDigest: 'abc' } };
  assert.equal(shouldAutoRollover(source, { latestTip: true, codeMatches: true }), true);
  assert.equal(shouldAutoRollover(source, { latestTip: false, codeMatches: true }), false);
  assert.equal(shouldAutoRollover(source, { latestTip: true, codeMatches: false }), false);
});
