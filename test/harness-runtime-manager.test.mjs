import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Manager, fixedGatewayTraceEligible } from '../src/manager.mjs';
import { snapshotArtifacts } from '../src/artifacts.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-harness-runtime-'));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'unchanged base file'); git('add', '.'); git('commit', '-qm', 'base');
  const manager = await new Manager({ stateDir: path.join(root, 'state'), allowedRoots: [root], maxConcurrent: 3, defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 60, defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [], provider: 'mock', model: 'mock', queue: { maxPending: 16, maxWaitSeconds: 3600 },
    verification: { maxSelected: 4, commands: [{ id: 'lint', readOnly: true }] }, offlineMaterials: { materials: [] } }, {}, { spawnWorker: false }).init();
  const write = job => fs.writeFile(path.join(manager.jobDir(job.id), 'job.json'), JSON.stringify(job));
  const checkpoint = async job => {
    const source = { baseCommit: job.baseCommit, inputMaterialsDigest: null, materialBaseline: [], entries: [] };
    const inputSnapshotDigest = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    const target = path.join(manager.jobDir(job.id), 'artifacts', 'private'); await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'checkpoint.json'), JSON.stringify({ version: 1, ...source, complete: true, inputSnapshotDigest }));
    return inputSnapshotDigest;
  };
  return { root, repository, manager, write, checkpoint };
}

test('followup inherits verifier selection and acceptance; empty selection cannot weaken it', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await manager.start({ repository, title: 'Task', prompt: 'Implement', verification_ids: ['lint'], acceptance: { version: 1, required_verification_ids: ['lint'], required_artifact_paths: ['base.txt'] } });
  await manager.dispatchOnce();
  const source = await manager.read(first.id); const digest = await checkpoint(source); source.status = 'completed'; source.sessionCheckpoint = { complete: true, size: 100 }; source.artifacts = { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'manifest' }; source.execution = { status: 'passed' };
  source.verification = { status: 'passed', verifiedSnapshotDigest: digest, commands: [{ id: 'lint', status: 'passed' }] }; await write(source);
  assert.equal((await manager.status(first.id)).acceptance.status, 'accepted');
  await assert.rejects(manager.start({ prompt: 'Next', verification_ids: [] }, first.id), /Acceptance requires selected verifier IDs/);
  const follow = await manager.start({ prompt: 'Next', request_id: 'follow-once' }, first.id);
  assert.equal((await manager.start({ prompt: 'Next', request_id: 'follow-once' }, first.id)).id, follow.id);
  assert.deepEqual((await manager.read(follow.id)).verificationIds, ['lint']);
  assert.deepEqual((await manager.read(follow.id)).acceptanceContract, source.acceptanceContract);
  await fs.rm(path.join(first.worktree, 'base.txt'));
  assert.equal((await manager.status(first.id)).acceptance.status, 'accepted');
});

test('review attestation binds completed review to source evidence and reports caller authority', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await manager.start({ repository, title: 'Task', prompt: 'Implement', acceptance: { version: 1, required_artifact_paths: ['base.txt'], require_review: true } });
  await manager.dispatchOnce();
  const source = await manager.read(first.id); const digest = await checkpoint(source); source.status = 'completed'; source.artifacts = { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'manifest' }; source.execution = { status: 'passed' }; await write(source);
  const started = await manager.review(first.id, { prompt: 'Review code' });
  const review = await manager.read(started.id); assert.equal(review.sessionFile, undefined); assert.equal(review.codeOnly, true);
  review.status = 'completed'; review.execution = { status: 'passed' }; review.artifacts = { checkpointComplete: true, inputSnapshotDigest: digest }; await write(review);
  const result = await manager.attestReview(first.id, { review_job_id: review.id, verdict: 'approved', request_id: 'review-once' });
  assert.equal(result.authority, 'caller'); assert.equal(result.acceptance.status, 'accepted');
  assert.equal((await manager.status(first.id)).acceptance.status, 'accepted');
  const withAttestation = await manager.read(first.id); withAttestation.artifacts.manifestSha256 = 'changed'; await write(withAttestation);
  assert.equal((await manager.status(first.id)).acceptance.status, 'accepted');
  const rejected = await manager.attestReview(first.id, { review_job_id: review.id, verdict: 'rejected', request_id: 'review-rejected' });
  assert.equal(rejected.acceptance.status, 'review_rejected');
  const changedReview = await manager.read(review.id); changedReview.artifacts.inputSnapshotDigest = 'different'; await write(changedReview);
  await assert.rejects(manager.attestReview(first.id, { review_job_id: review.id, verdict: 'approved', request_id: 'review-stale' }), /mismatch/);
});

test('code-only rollover restores immutable source changes, seals old raw session, and preserves root objective', async t => {
  const { root, repository, manager, write } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await manager.start({ repository, title: 'Task', prompt: 'Original objective' });
  await manager.dispatchOnce();
  const source = await manager.read(first.id);
  await fs.writeFile(path.join(source.worktree, 'changed.txt'), 'source change');
  const artifact = await snapshotArtifacts({ jobDir: manager.jobDir(source.id), worktree: source.worktree, baseCommit: source.baseCommit });
  source.status = 'completed'; source.execution = { status: 'passed' }; source.artifacts = { checkpointComplete: true, inputSnapshotDigest: artifact.inputSnapshotDigest, manifestSha256: artifact.manifestSha256 };
  source.sessionCheckpoint = { complete: false, reason: 'raw_session_too_large', size: 17 * 1024 * 1024 }; source.sessionFile = path.join(source.sessionDir, 'oversized.jsonl');
  await fs.writeFile(source.sessionFile, 'private raw history'); await write(source);
  const started = await manager.rollover(source.id, { prompt: 'Next task', request_id: 'roll-once' });
  assert.equal(started.rolloverFromId, source.id);
  assert.equal(started.rolloverSourceSnapshotDigest, artifact.inputSnapshotDigest);
  assert.equal((await manager.read(started.id)).handoff.objective, 'Original objective');
  assert.equal(await fs.access(path.join(source.sessionDir, 'session-seal.json')).then(() => true, () => false), true);
  await manager.dispatchOnce();
  assert.equal(await fs.readFile(path.join(started.worktree, 'changed.txt'), 'utf8'), 'source change');
  const child = await manager.read(started.id); assert.equal(child.sessionDir === source.sessionDir, false); assert.equal(child.forkSessionFile, undefined);
  await assert.rejects(manager.start({ prompt: 'Implicit old session' }, source.id), /sealed/);
  assert.equal((await manager.rollover(source.id, { prompt: 'Next task', request_id: 'roll-once' })).id, started.id);
  child.status = 'completed'; child.execution = { status: 'passed' }; await write(child);
  const removed = await manager.cleanup({ job_ids: [child.id], dry_run: false });
  assert.deepEqual(removed.removed, [child.id]);
  await assert.rejects(manager.start({ prompt: 'Implicit after child cleanup' }, source.id), /sealed/);
});

test('internal gateway trace requires validated profile, selected provider and exact fixed endpoint', () => {
  const config = { configFile: '/etc/pi-internal/config.json', provider: 'corporate', model: 'approved', modelsFile: '/etc/pi-internal/models.json' };
  const job = { provider: 'corporate', model: 'approved' };
  const models = { providers: { corporate: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:18080/v1', models: [{ id: 'approved' }] } } };
  assert.equal(fixedGatewayTraceEligible(true, config, job, models), true);
  assert.equal(fixedGatewayTraceEligible(false, config, job, models), false);
  assert.equal(fixedGatewayTraceEligible(true, config, { ...job, provider: 'other' }, models), false);
  assert.equal(fixedGatewayTraceEligible(true, config, { ...job, model: 'other' }, models), false);
  assert.equal(fixedGatewayTraceEligible(true, config, job, { providers: { corporate: { ...models.providers.corporate, baseUrl: 'https://other.example/v1' } } }), false);
});

test('rollover rejects pending or running session aliases and dispatch rechecks a newly sealed session', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await manager.start({ repository, title: 'Task', prompt: 'A' }); await manager.dispatchOnce();
  const source = await manager.read(first.id); const digest = await checkpoint(source);
  Object.assign(source, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'manifest' }, sessionCheckpoint: { complete: true, size: 10 } }); await write(source);
  const sibling = await manager.start({ prompt: 'B' }, source.id);
  await assert.rejects(manager.rollover(source.id, { prompt: 'Continue' }), /active|queued|pending/i);
  const queued = await manager.read(sibling.id); queued.status = 'running'; await write(queued);
  await assert.rejects(manager.rollover(source.id, { prompt: 'Continue' }), /active|queued|pending/i);
  queued.status = 'queued'; await write(queued);
  await fs.writeFile(path.join(source.sessionDir, 'session-seal.json'), JSON.stringify({ version: 1, sourceJobId: source.id, targetJobId: sibling.id, codeSnapshotDigest: digest }));
  await manager.dispatchOnce();
  assert.equal((await manager.read(sibling.id)).status, 'failed');
  assert.match((await manager.read(sibling.id)).error, /sealed/);
});

test('rollover retry and cleanup repair a missing durable seal', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await manager.start({ repository, title: 'Task', prompt: 'A' }); await manager.dispatchOnce();
  const source = await manager.read(first.id); const digest = await checkpoint(source);
  Object.assign(source, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'manifest' } }); await write(source);
  const input = { prompt: 'Continue', request_id: 'repair-seal' };
  const child = await manager.rollover(source.id, input);
  await fs.rm(path.join(source.sessionDir, 'session-seal.json'));
  assert.equal((await manager.rollover(source.id, input)).id, child.id);
  assert.equal(await manager.sessionSealed(source.sessionDir), true);
  const childRaw = await manager.read(child.id); childRaw.status = 'completed'; childRaw.execution = { status: 'passed' }; await write(childRaw);
  await fs.rm(path.join(source.sessionDir, 'session-seal.json'));
  const removed = await manager.cleanup({ job_ids: [child.id], dry_run: false });
  assert.deepEqual(removed.removed, [child.id]);
  assert.equal(await manager.sessionSealed(source.sessionDir), true);
  await assert.rejects(manager.start({ prompt: 'Old alias' }, source.id), /sealed/);
});

test('reviewer acceptance must pass and attestation history fails closed at capacity', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await manager.start({ repository, title: 'Task', prompt: 'A', acceptance: { version: 1, require_review: true } }); await manager.dispatchOnce();
  const source = await manager.read(first.id); const digest = await checkpoint(source);
  Object.assign(source, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'manifest' } }); await write(source);
  const reviewStart = await manager.review(first.id, { prompt: 'Review', acceptance: { version: 1, required_artifact_paths: ['missing.txt'] } });
  const review = await manager.read(reviewStart.id); Object.assign(review, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'review-manifest' } }); await write(review);
  await assert.rejects(manager.attestReview(first.id, { review_job_id: review.id, verdict: 'approved', request_id: 'bad-review' }), /review.*acceptance/i);
  review.acceptanceContract = null; await write(review);
  for (let index = 0; index < 32; index++) await manager.attestReview(first.id, { review_job_id: review.id, verdict: index === 31 ? 'rejected' : 'approved', request_id: `receipt-${index}` });
  assert.equal((await manager.status(first.id)).acceptance.status, 'review_rejected');
  await assert.rejects(manager.attestReview(first.id, { review_job_id: review.id, verdict: 'approved', request_id: 'receipt-overflow' }), /capacity|full/i);
  assert.equal((await manager.attestReview(first.id, { review_job_id: review.id, verdict: 'approved', request_id: 'receipt-0' })).acceptance.status, 'review_rejected');
});

test('ordinary continuation ledger survives a later fresh rollover', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await manager.start({ repository, title: 'Task', prompt: 'A' }); await manager.dispatchOnce();
  const source = await manager.read(first.id); const firstDigest = await checkpoint(source);
  Object.assign(source, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: firstDigest, manifestSha256: 'manifest' } }); await write(source);
  const follow = await manager.start({ prompt: 'B; preserve C' }, source.id);
  assert.deepEqual((await manager.read(follow.id)).authoritativeInstructions, ['A', 'B; preserve C']);
  await manager.dispatchOnce();
  const followRaw = await manager.read(follow.id); const followDigest = await checkpoint(followRaw);
  Object.assign(followRaw, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: followDigest, manifestSha256: 'manifest' } }); await write(followRaw);
  const rolled = await manager.rollover(follow.id, { prompt: 'Continue' });
  const result = await manager.read(rolled.id);
  assert.deepEqual(result.handoff.authoritativeInstructions, ['A', 'B; preserve C', 'Continue']);
  assert.deepEqual(result.authoritativeInstructions, result.handoff.authoritativeInstructions);
});

test('ambiguous steering delivery blocks fresh continuation', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await manager.start({ repository, title: 'Task', prompt: 'A' }); await manager.dispatchOnce();
  const source = await manager.read(first.id); const digest = await checkpoint(source);
  Object.assign(source, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'manifest' } }); await write(source);
  const controls = path.join(manager.jobDir(source.id), 'controls'); await fs.mkdir(controls);
  await fs.writeFile(path.join(controls, 'processing-00000000-0000-4000-8000-000000000001.json'), JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', message: 'Possibly delivered' }));
  await assert.rejects(manager.rollover(source.id, { prompt: 'Continue' }), /steering.*unresolved/i);
  await assert.rejects(manager.start({ prompt: 'Continue raw' }, source.id), /steering.*unresolved/i);
  const review = await manager.review(source.id, { prompt: 'Inspect immutable code only' });
  assert.equal((await manager.read(review.id)).codeOnly, true);
});

test('ordinary 10001 character task remains admissible but rollover refuses oversized handoff', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const started = await manager.start({ repository, title: 'Long task', prompt: 'A'.repeat(10001) });
  await manager.dispatchOnce();
  const source = await manager.read(started.id); const digest = await checkpoint(source);
  Object.assign(source, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'manifest' } }); await write(source);
  await assert.rejects(manager.rollover(source.id, { prompt: 'Continue' }), /too large/);
});

test('ordinary 40001 Korean character prompt remains admissible while rollover fails bounded handoff', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const started = await manager.start({ repository, title: 'Korean task', prompt: '가'.repeat(40001) });
  await manager.dispatchOnce();
  const source = await manager.read(started.id); const digest = await checkpoint(source);
  Object.assign(source, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'manifest' } }); await write(source);
  await assert.rejects(manager.rollover(source.id, { prompt: 'Continue' }), /too large/);
});

test('initial image context blocks automatic fresh rollover while code review remains available', async t => {
  const { root, repository, manager, write, checkpoint } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex').toString('base64');
  const started = await manager.start({ repository, title: 'Image task', prompt: 'Inspect image', images: [{ mimeType: 'image/png', data: png }] });
  await manager.dispatchOnce();
  const source = await manager.read(started.id); const digest = await checkpoint(source);
  Object.assign(source, { status: 'completed', execution: { status: 'passed' }, artifacts: { checkpointComplete: true, inputSnapshotDigest: digest, manifestSha256: 'manifest' }, sessionCheckpoint: { complete: true, size: 15 * 1024 * 1024 } }); await write(source);
  await assert.rejects(manager.start({ prompt: 'Continue' }, source.id), /image context/i);
  const review = await manager.review(source.id, { prompt: 'Review code' });
  assert.equal((await manager.read(review.id)).codeOnly, true);
});
