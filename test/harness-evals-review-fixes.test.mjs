import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTask, parseTrace, taskContractDigest } from '../evals/schema.mjs';
import { gradeTask, GRADER_VERSION } from '../evals/grader.mjs';
import { buildReport } from '../evals/report.mjs';
import { compareReports } from '../evals/compare.mjs';
import { submitLiveRun, pollLiveRun } from '../evals/live-adapter.mjs';
import { sha256Hex, stableStringify } from '../evals/util.mjs';
import { Manager } from '../src/manager.mjs';
import { normalizeAcceptance } from '../src/acceptance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'scripts', 'evaluate-harness.mjs');
const sha = 'a'.repeat(40), digest = 'b'.repeat(64), fingerprint = 'sha256:' + 'c'.repeat(64);
const task = (id = 'review-fix', overrides = {}) => parseTask({
  id, scenario: 'successful_completion', prompt: 'Update target.',
  criteria: [{ id: 'artifact', kind: 'artifact', description: 'Target changed.' }],
  expectedEvidence: { changedPaths: ['target.txt'], requiredVerifierIds: [], requiresReview: false, requiresResume: true,
    requiredConstraintIds: ['keep-base'], constraintEvidence: [{ constraintId: 'keep-base', path: 'base.txt' }] },
  ...overrides,
});
const trace = (item, overrides = {}) => parseTrace({
  taskId: item.id, runId: 'review-run', origin: 'synthetic', harnessCommit: sha, taskBaseCommit: sha,
  configFingerprint: fingerprint, execution: { jobId: 'job-one', status: 'completed', codeDigest: digest },
  artifacts: { changedPaths: ['target.txt'], presentPaths: ['target.txt'], unchangedPaths: ['base.txt'] },
  verification: null, review: null, retainedConstraintIds: ['keep-base'],
  resumeEvents: [{ eventId: 'e1', requestId: 'req-one', jobId: 'job-one' }], eventsTruncated: false,
  timing: { durationMs: 100 }, usageAvailability: { totalTokens: 'available', costUsd: 'available' },
  usage: { totalTokens: 10, costUsd: 0.01, observedResponses: 1 }, ...overrides,
});
const suite = tasks => ({ version: 'v1', digest: sha256Hex(stableStringify(tasks)), tasks });
const report = (tasks, traces, selectedTaskIds = tasks.map(item => item.id)) => buildReport({
  suite: suite(tasks), traces, selectedTaskIds, graderVersion: GRADER_VERSION,
  harnessCommit: sha, taskBaseCommit: sha, configFingerprint: fingerprint, origin: 'synthetic',
});
function clone(value) { return structuredClone(value); }

test('report parser rejects fabricated success and impossible missing outcome measurements', () => {
  const item = task();
  const failed = report([item], [trace(item, { artifacts: { changedPaths: [], presentPaths: [], unchangedPaths: ['base.txt'] } })]);
  const success = clone(failed);
  success.result.perTask[0].taskSuccess = true;
  success.result.taskSuccess.passed = 1; success.result.taskSuccess.rate = 1;
  assert.throws(() => compareReports(failed, success));

  const other = task('missing-review');
  const missing = report([item, other], [trace(item)]);
  const measured = clone(missing);
  measured.result.perTask[1].latencyMs = 0;
  measured.result.perTask[1].usage = { totalTokens: 0, costUsd: 0, observedResponses: 1 };
  measured.result.latencyMs = { value: 50, observedCount: 2, applicableCount: 2, unknownCount: 0 };
  measured.result.usage.totalTokens = { value: 5, observedCount: 2, applicableCount: 2, unknownCount: 0 };
  measured.result.usage.costUsd = { value: 0.005, observedCount: 2, applicableCount: 2, unknownCount: 0 };
  assert.throws(() => compareReports(missing, measured));
});

test('report parser checks categorical values, criterion reasons, and aggregate counts against per-task evidence', () => {
  const item = task(), base = report([item], [trace(item)]);
  const categorical = clone(base); categorical.result.perTask[0].constraintRetention = 'invented';
  assert.throws(() => compareReports(base, categorical));
  const reason = clone(base); reason.result.perTask[0].criteria[0].reason = 'PRIVATE_SENTINEL_REASON';
  assert.throws(() => compareReports(base, reason));
  const aggregate = clone(base);
  aggregate.result.constraintRetention = { retained: 0, lost: 1, unknown: 0, applicable: 1 };
  assert.throws(() => compareReports(base, aggregate));
  const applicability = clone(base);
  applicability.result.perTask[0].constraintApplicable = false;
  assert.throws(() => compareReports(base, applicability));
  const metric = clone(base);
  metric.result.latencyMs.value = 99;
  assert.throws(() => compareReports(base, metric));
});

async function managerFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-review-registry-'));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  const config = { stateDir: path.join(root, 'manager-state'), allowedRoots: [root], maxConcurrent: 2,
    defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60, defaultMaxTurns: 2, piPath: '/bin/true',
    allowedCommands: [], provider: 'mock', model: 'mock',
    verification: { commands: [], maxSelected: 1 } };
  const manager = await new Manager(config, { PATH: process.env.PATH, HOME: process.env.HOME }, { spawnWorker: false }).init();
  const item = task();
  const input = { manager, stateDir: path.join(root, 'state-A'), runId: 'same-run', suiteDigest: 'd'.repeat(64),
    harnessCommit: sha, selectedTaskIds: [item.id], tasks: [item], task: item, repository, baseCommit,
    config, acknowledgeLive: true };
  return { root, manager, config, item, input };
}
test('alternate caller stateDir cannot bypass Manager-owned run identity, while exact retries reconcile', async t => {
  const f = await managerFixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const original = f.manager.start.bind(f.manager); let lost = false;
  f.manager.start = async (...args) => { const started = await original(...args); if (!lost) { lost = true; throw new Error('lost response'); } return started; };
  await assert.rejects(submitLiveRun(f.input), /lost response/);
  const otherDir = { ...f.input, stateDir: path.join(f.root, 'state-B') };
  const [one, two] = await Promise.all([submitLiveRun(f.input), submitLiveRun(f.input)]);
  assert.equal(one.jobId, two.jobId);
  assert.equal((await fs.readdir(f.manager.jobsDir)).length, 1);
  await assert.rejects(submitLiveRun({ ...otherDir, config: { ...f.config, thinkingLevel: 'high' } }));
  assert.equal((await submitLiveRun(otherDir)).jobId, one.jobId);
});

test('deleted required artifact remains a change but does not satisfy presence', async () => {
  const item = task('delete-target', { expectedEvidence: {
    changedPaths: ['target.txt'], requiredVerifierIds: ['unit'], requiresReview: false, requiresResume: false,
    requiredConstraintIds: [], constraintEvidence: [] } });
  const manager = {
    status: async () => ({ id: 'job-one', status: 'completed', execution: { status: 'passed' },
      artifacts: { checkpointComplete: true, inputSnapshotDigest: digest }, usageAvailability: {} }),
    read: async () => ({ id: 'job-one', requestId: 'req-one', baseCommit: sha, verificationIds: ['unit'],
      acceptanceContract: normalizeAcceptance({ version: 1, required_verification_ids: ['unit'],
        required_artifact_paths: ['target.txt'], require_review: false }),
      verification: { status: 'passed', verifiedSnapshotDigest: digest, commands: [{ id: 'unit', status: 'passed' }] } }),
    artifacts: async () => ({ checkpointComplete: true, inputSnapshotDigest: digest, entries: [
      { type: 'delete', path: 'target.txt', complete: true, applicable: true, redacted: false } ], nextCursor: null }),
    sourcePathExists: async () => false,
  };
  const polled = await pollLiveRun({ manager, jobId: 'job-one', timeoutMs: 0, task: item,
    submission: { jobId: 'job-one', requestId: 'req-one', configFingerprint: fingerprint },
    runId: 'review-run', harnessCommit: sha, taskBaseCommit: sha });
  assert.deepEqual(polled.trace.artifacts.changedPaths, ['target.txt']);
  assert.equal(gradeTask(item, polled.trace).taskSuccess, false);
});

test('failed execution retains independently proven file preservation; absent evidence stays unknown', () => {
  const item = task();
  const failed = { status: 'failed', jobId: 'job-one', codeDigest: digest };
  const retained = gradeTask(item, trace(item, { execution: failed }));
  assert.equal(retained.taskSuccess, false);
  assert.equal(retained.constraintRetention, 'retained');
  const lost = gradeTask(item, trace(item, { execution: failed, artifacts: { changedPaths: ['target.txt'], presentPaths: ['target.txt'], unchangedPaths: [] },
    retainedConstraintIds: [] }));
  assert.equal(lost.constraintRetention, 'lost');
  const unknown = gradeTask(item, trace(item, { execution: failed, artifacts: { changedPaths: ['target.txt'], presentPaths: ['target.txt'], unchangedPaths: null },
    retainedConstraintIds: null }));
  assert.equal(unknown.constraintRetention, 'unknown');
});

test('CLI stderr never echoes malformed JSON or invalid enum private sentinels', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-review-cli-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = 'PRIVATE_SENTINEL_93d18';
  const invalidJson = path.join(root, 'invalid.json'), invalidEnum = path.join(root, 'enum.json'), invalidStatus = path.join(root, 'status.json');
  await fs.writeFile(invalidJson, '{"'+marker+'":}');
  await fs.writeFile(invalidEnum, JSON.stringify([{ ...trace(task()), origin: marker }]));
  await fs.writeFile(invalidStatus, JSON.stringify([{ ...trace(task()), execution: { jobId: 'job-one', status: marker, codeDigest: digest } }]));
  const args = ['--harness-commit', sha, '--task-base-commit', sha, '--config-fingerprint', fingerprint];
  for (const file of [invalidJson, invalidEnum, invalidStatus]) {
    const child = spawnSync(process.execPath, [cli, 'replay', '--traces', file, ...args],
      { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout.includes(marker) || child.stderr.includes(marker), false);
    assert.ok(child.stderr.length < 300);
  }
});

test('CLI live rejects dirty evaluator code before Manager state creation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-review-dirty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const evaluation = path.join(root, 'evaluation'), repository = path.join(root, 'task');
  await fs.mkdir(evaluation); await fs.mkdir(repository);
  const sourceRoot = path.join(here, '..');
  for (const name of ['src','evals','scripts','internal-agent','package.json'])
    await fs.cp(path.join(sourceRoot, name), path.join(evaluation, name), { recursive: true });
  await fs.symlink(path.join(sourceRoot, 'node_modules'), path.join(evaluation, 'node_modules'));
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  for (const dir of [evaluation,repository]) {
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'test@example.invalid'); git(dir, 'config', 'user.name', 'Test');
  }
  git(evaluation, 'add', 'src','evals','scripts','internal-agent','package.json'); git(evaluation, 'commit', '-qm', 'base');
  await fs.writeFile(path.join(evaluation, 'evals', 'grader.mjs'), '\n// dirty evaluator\n', { flag: 'a' });
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'base');
  const configFile = path.join(root, 'config.json'), managerState = path.join(root, 'manager-state');
  await fs.writeFile(configFile, JSON.stringify({ piPath: path.join(here, 'fixtures', 'harness-runtime-fake-pi.mjs'),
    stateDir: managerState, allowedRoots: [root], provider: 'mock', model: 'mock', maxConcurrent: 2,
    defaultTimeoutSeconds: 15, maxTimeoutSeconds: 30, defaultMaxTurns: 3,
    verification: { commands: [{ id: 'lint', argv: ['/usr/bin/true'], timeoutSeconds: 3, maxOutputBytes: 1000, readOnly: true }] } }));
  const child = spawnSync(process.execPath, [path.join(evaluation, 'scripts', 'evaluate-harness.mjs'), 'live', '--live',
    '--ack', 'I-UNDERSTAND-THIS-SUBMITS-TO-THE-CONFIGURED-PI-MCP-MANAGER', '--run-id', 'dirty-run',
    '--select', 'fix-null-check', '--repository', repository, '--base-commit', git(repository, 'rev-parse', 'HEAD'),
    '--state-dir', path.join(root, 'caller-state'), '--config', configFile, '--run-timeout-ms', '0'],
    { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(child.status, 0);
  assert.equal((await fs.readdir(managerState).catch(() => [])).length, 0);
  git(evaluation, 'checkout', '--', 'evals/grader.mjs');
  const marker = 'PRIVATE_CONFIG_SENTINEL_9c7f';
  await fs.writeFile(configFile, '{"' + marker + '":}');
  const retry = spawnSync(process.execPath, [path.join(evaluation, 'scripts', 'evaluate-harness.mjs'), 'live', '--live',
    '--ack', 'I-UNDERSTAND-THIS-SUBMITS-TO-THE-CONFIGURED-PI-MCP-MANAGER', '--run-id', 'config-run',
    '--select', 'fix-null-check', '--repository', repository, '--base-commit', git(repository, 'rev-parse', 'HEAD'),
    '--state-dir', path.join(root, 'caller-state'), '--config', configFile, '--run-timeout-ms', '0'],
    { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(retry.status, 0);
  assert.equal(retry.stderr.includes(marker), false);
  assert.ok(retry.stderr.length < 300);
  await fs.writeFile(path.join(root, marker), 'not-a-directory');
  await fs.writeFile(configFile, JSON.stringify({ piPath: path.join(here, 'fixtures', 'harness-runtime-fake-pi.mjs'),
    stateDir: path.join(root, marker), allowedRoots: [root], provider: 'mock', model: 'mock', maxConcurrent: 2,
    defaultTimeoutSeconds: 15, maxTimeoutSeconds: 30, defaultMaxTurns: 3,
    verification: { commands: [{ id: 'lint', argv: ['/usr/bin/true'], timeoutSeconds: 3, maxOutputBytes: 1000, readOnly: true }] } }));
  const managerFailure = spawnSync(process.execPath, [path.join(evaluation, 'scripts', 'evaluate-harness.mjs'), 'live', '--live',
    '--ack', 'I-UNDERSTAND-THIS-SUBMITS-TO-THE-CONFIGURED-PI-MCP-MANAGER', '--run-id', 'manager-run',
    '--select', 'fix-null-check', '--repository', repository, '--base-commit', git(repository, 'rev-parse', 'HEAD'),
    '--state-dir', path.join(root, 'caller-state'), '--config', configFile, '--run-timeout-ms', '0'],
    { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(managerFailure.status, 0);
  assert.equal(managerFailure.stderr.includes(marker), false);
  assert.ok(managerFailure.stderr.length < 300);
});
