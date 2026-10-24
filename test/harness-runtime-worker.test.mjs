import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig, buildChildEnv } from '../src/config.mjs';
import { Manager } from '../src/manager.mjs';
import { Workflow } from '../src/workflow.mjs';

const fake = fileURLToPath(new URL('./fixtures/harness-runtime-fake-pi.mjs', import.meta.url));
const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'context_limit', 'idle_timeout', 'tool_failure_limit', 'quarantined']);
async function waitJob(manager, id) {
  for (let index = 0; index < 120; index++) {
    const job = await manager.status(id, 1);
    if (terminal.has(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Job did not become terminal');
}

test('oversized raw history preserves completed code/verification and supports code-only review; idle and failures stop truthfully', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-harness-worker-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  await fs.chmod(fake, 0o755);
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ piPath: fake, stateDir: path.join(root, 'state'), allowedRoots: [root], provider: 'mock', model: 'mock',
    maxConcurrent: 2, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 30, defaultMaxTurns: 3,
    queue: { maxPending: 8, maxWaitSeconds: 60, dispatchIntervalMs: 100 },
    verification: { commands: [{ id: 'unit', argv: ['/usr/bin/true'], timeoutSeconds: 3, maxOutputBytes: 1000, readOnly: true },
      { id: 'slow', argv: ['/bin/sleep', '2'], timeoutSeconds: 4, maxOutputBytes: 1000, readOnly: true }] },
    observation: { idleTimeoutMs: 1200, consecutiveFailureLimit: 2 } }));
  const config = await loadConfig(configFile);
  const manager = await new Manager(config, buildChildEnv(config)).init();
  const sourceStart = await manager.start({ repository, title: 'Oversize', prompt: 'Implement [OVERSIZE]', verification_ids: ['unit', 'slow'],
    acceptance: { version: 1, required_verification_ids: ['unit'], required_artifact_paths: ['code.txt'], require_review: true } });
  const source = await waitJob(manager, sourceStart.id);
  const sourcePrivate = await manager.read(source.id);
  assert.equal(source.status, 'completed', JSON.stringify(source));
  assert.equal(source.verification.status, 'passed');
  assert.equal(source.sessionCheckpoint.complete, false);
  assert.equal(source.sessionCheckpoint.reason, 'raw_session_too_large');
  assert.ok((await fs.stat(path.join(sourcePrivate.sessionDir, 'runtime-fixture.jsonl'))).size > 16 * 1024 * 1024);
  assert.equal(source.artifacts.checkpointComplete, true);
  assert.equal(source.acceptance.status, 'pending_review');
  const reviewStart = await manager.review(source.id, { prompt: 'Review immutable code' });
  const review = await waitJob(manager, reviewStart.id);
  assert.equal(review.status, 'completed', JSON.stringify(review));
  assert.equal(review.reviewSourceSnapshotDigest, source.artifacts.inputSnapshotDigest);
  assert.equal(review.artifacts.inputSnapshotDigest, source.artifacts.inputSnapshotDigest);
  const attested = await manager.attestReview(source.id, { review_job_id: review.id, verdict: 'approved', request_id: 'approved-review' });
  assert.equal(attested.acceptance.status, 'accepted');
  const continuationStart = await manager.start({ prompt: 'Continue code' }, source.id);
  const continuation = await waitJob(manager, continuationStart.id);
  assert.equal(continuation.status, 'completed', JSON.stringify(continuation));
  assert.notEqual((await manager.read(continuation.id)).sessionDir, sourcePrivate.sessionDir);
  assert.equal(continuation.acceptance.status, 'pending_review');
  assert.equal(await fs.access(path.join(sourcePrivate.sessionDir, 'session-seal.json')).then(() => true, () => false), true);
  const idleStart = await manager.start({ repository, title: 'Idle', prompt: '[IDLE]' });
  const idle = await waitJob(manager, idleStart.id);
  assert.equal(idle.status, 'idle_timeout', JSON.stringify(idle));
  assert.equal(idle.artifacts.checkpointComplete, true);
  assert.equal(await fs.readFile(path.join(idle.worktree, 'code.txt'), 'utf8'), 'retained code\n');
  const failureStart = await manager.start({ repository, title: 'Failures', prompt: '[FAILURES]' });
  const failure = await waitJob(manager, failureStart.id);
  assert.equal(failure.status, 'tool_failure_limit', JSON.stringify(failure));
  assert.equal(failure.artifacts.checkpointComplete, true);
  const contextStart = await manager.start({ repository, title: 'Context stop', prompt: '[CONTEXT_STOP]' });
  const context = await waitJob(manager, contextStart.id);
  assert.equal(context.status, 'context_limit', JSON.stringify(context));
  assert.equal(context.artifacts.checkpointComplete, true);
  const mixedStart = await manager.start({ repository, title: 'Mixed usage', prompt: '[MIXED_USAGE]' });
  const mixed = await waitJob(manager, mixedStart.id);
  assert.equal(mixed.status, 'completed', JSON.stringify(mixed));
  assert.ok(mixed.usage.input > 0);
  assert.equal(mixed.usageAvailability.totalTokens, false);
  assert.equal(mixed.usageAvailability.costUsd, false);
  assert.equal(mixed.usageAvailability.observedResponses, 2);
  const workflow = new Workflow(manager);
  const goal = await workflow.create({ version: 1, stages: [
    { kind: 'delegate', input: { repository, title: 'Invalid usage', prompt: '[INVALID_USAGE]' } },
    { kind: 'followup', input: { prompt: 'Continue' } }
  ], budget: { maxTotalTokens: 100, maxCostUsd: 1 } });
  const admitted = await workflow.advance(goal.id);
  const invalid = await waitJob(manager, admitted.activeJobId);
  assert.equal(invalid.status, 'completed', JSON.stringify(invalid));
  assert.ok(invalid.usage.totalTokens > 0 && invalid.usage.cost.total > 0);
  assert.equal(invalid.usageAvailability.totalTokens, false);
  assert.equal(invalid.usageAvailability.costUsd, false);
  assert.equal(invalid.usageAvailability.observedResponses, 2);
  const blocked = await workflow.advance(goal.id);
  assert.equal(blocked.blockedReason, 'usage_unavailable');
  assert.deepEqual(blocked.observedUsage, { totalTokens: null, costUsd: null });
});

test('accepted steering text is authoritative in a later fresh rollover', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-harness-steer-ledger-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  await fs.chmod(fake, 0o755);
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ piPath: fake, stateDir: path.join(root, 'state'), allowedRoots: [root], provider: 'mock', model: 'mock',
    maxConcurrent: 2, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 30, defaultMaxTurns: 3, queue: { maxPending: 8, maxWaitSeconds: 60, dispatchIntervalMs: 100 } }));
  const config = await loadConfig(configFile); const manager = await new Manager(config, buildChildEnv(config)).init();
  const started = await manager.start({ repository, title: 'Steer', prompt: 'A [STEER_HOLD]' });
  for (let i = 0; i < 80; i++) { const current = await manager.status(started.id); if (current.status === 'running' && current.sessionFile) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const ack = await manager.steer(started.id, { message: 'Preserve C' });
  assert.equal(ack.status, 'handled_by_pi');
  const completed = await waitJob(manager, started.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual((await manager.read(started.id)).authoritativeInstructions, ['A [STEER_HOLD]', 'Preserve C']);
  const rolled = await manager.rollover(started.id, { prompt: 'Continue' });
  assert.deepEqual((await manager.read(rolled.id)).handoff.authoritativeInstructions, ['A [STEER_HOLD]', 'Preserve C', 'Continue']);
  const imageStart = await manager.start({ repository, title: 'Image steer', prompt: 'A [STEER_HOLD]' });
  for (let i = 0; i < 80; i++) { const current = await manager.status(imageStart.id); if (current.status === 'running' && current.sessionFile) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex').toString('base64');
  const imageAck = await manager.steer(imageStart.id, { message: 'Use this image', images: [{ mimeType: 'image/png', data: png }] });
  assert.equal(imageAck.status, 'handled_by_pi');
  const imageDone = await waitJob(manager, imageStart.id);
  assert.equal(imageDone.status, 'completed');
  assert.equal((await manager.read(imageStart.id)).imageContextRequired, true);
  await assert.rejects(manager.rollover(imageStart.id, { prompt: 'Continue' }), /image context/i);
});
