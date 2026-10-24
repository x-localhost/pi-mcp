import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTask, parseTrace, taskContractDigest } from '../evals/schema.mjs';
import { gradeTask, gradeSuite, GRADER_VERSION } from '../evals/grader.mjs';
import { buildReport, writeReport } from '../evals/report.mjs';
import { compareReports } from '../evals/compare.mjs';
import { submitLiveRun, pollLiveRun, effectiveConfigFingerprint } from '../evals/live-adapter.mjs';
import { contractDigest, normalizeAcceptance } from '../src/acceptance.mjs';
import { sha256Hex, stableStringify } from '../evals/util.mjs';
import { Manager } from '../src/manager.mjs';
import { loadConfig, buildChildEnv } from '../src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'scripts', 'evaluate-harness.mjs');
const sha = 'a'.repeat(40), code = 'b'.repeat(64), fp = 'sha256:' + 'c'.repeat(64);
const task = () => parseTask({ id: 'evaluate-fix', scenario: 'successful_completion', prompt: 'Fix the target file.',
  criteria: [{ id: 'artifact', kind: 'artifact', description: 'Change target.' }, { id: 'verification', kind: 'verification', description: 'Run unit.' }],
  expectedEvidence: { changedPaths: ['target.txt'], requiredVerifierIds: ['unit'], requiresReview: false, requiresResume: false,
    requiredConstraintIds: ['preserve-base'], constraintEvidence: [{ constraintId: 'preserve-base', path: 'base.txt' }] } });
const trace = (item, overrides = {}) => parseTrace({ taskId: item.id, runId: 'run-one', origin: 'synthetic', harnessCommit: sha,
  taskBaseCommit: sha, configFingerprint: fp, execution: { jobId: 'job-one', status: 'completed', codeDigest: code },
  artifacts: { changedPaths: ['target.txt'], unchangedPaths: ['base.txt'] },
  verification: { jobId: 'job-one', codeDigest: code, contractDigest: taskContractDigest(item), verifierIds: ['unit'], status: 'passed' },
  review: null, retainedConstraintIds: ['preserve-base'], resumeEvents: [], eventsTruncated: false,
  timing: { durationMs: 100 }, usageAvailability: { totalTokens: 'available', costUsd: 'available' },
  usage: { totalTokens: 10, costUsd: 0.01, observedResponses: 1 }, ...overrides });
const suite = item => ({ version: 'v1', digest: sha256Hex(stableStringify([item])), tasks: [item] });

test('runtime acceptance digest binds verification and malformed predicates reject', () => {
  const item = task();
  const runtime = normalizeAcceptance({ version: 1, required_verification_ids: ['unit'], required_artifact_paths: ['target.txt'], require_review: false });
  assert.equal(taskContractDigest(item), contractDigest(runtime));
  assert.throws(() => parseTask({ ...item, criteria: [{ id: 'x', kind: 'invented', description: 'No' }] }));
  assert.throws(() => parseTask({ ...item, criteria: [...item.criteria, item.criteria[0]] }));
  assert.throws(() => trace(item, { artifacts: { changedPaths: ['target.txt'], unchangedPaths: ['target.txt'] } }));
  assert.throws(() => trace(item, { review: { jobId: 'job-one', reviewJobId: 'job-one', codeDigest: code, contractDigest: taskContractDigest(item), verdict: 'approved' } }));
});

test('unknown file evidence cannot pass and selected/observed coverage is strict', () => {
  const item = task();
  const unknown = trace(item, { artifacts: { changedPaths: null, unchangedPaths: null }, retainedConstraintIds: null });
  const graded = gradeTask(item, unknown);
  assert.equal(graded.taskSuccess, false);
  assert.equal(graded.constraintRetention, 'unknown');
  assert.equal(graded.criteria.find(entry => entry.kind === 'constraint').outcome, 'unknown');
  assert.throws(() => gradeSuite({ suite: suite(item), traces: [trace(item)], selectedTaskIds: [item.id, item.id] }));
  assert.throws(() => gradeSuite({ suite: suite(item), traces: [trace(item)], selectedTaskIds: [] }));
  assert.throws(() => gradeSuite({ suite: suite(item), traces: [trace(item)], selectedTaskIds: ['unknown-task'] }));
});

test('reports reconstruct results, reject malformed coverage, and provide numeric deltas', async () => {
  const item = task(), selectedTaskIds = [item.id], raw = trace(item);
  const args = { suite: suite(item), graderVersion: GRADER_VERSION, selectedTaskIds,
    harnessCommit: sha, taskBaseCommit: sha, configFingerprint: fp, origin: 'synthetic' };
  const base = buildReport({ ...args, traces: [raw], result: { arbitrarySecret: 'DO-NOT-EMIT' } });
  assert.equal(JSON.stringify(base).includes('DO-NOT-EMIT'), false);
  const candidate = buildReport({ ...args, traces: [trace(item, { timing: { durationMs: 150 },
    usage: { totalTokens: 15, costUsd: 0.03, observedResponses: 1 } })] });
  const compared = compareReports(base, candidate);
  assert.equal(compared.latencyMs.candidateMinusBaseline, 50);
  assert.equal(compared.usage.totalTokens.candidateMinusBaseline, 5);
  assert.throws(() => compareReports(base, { ...candidate, reportVersion: 'v999' }));
  assert.throws(() => compareReports(base, { ...candidate, result: { ...candidate.result, perTask: [] } }));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-report-limit-'));
  await assert.rejects(writeReport(path.join(tmp, 'large.json'), { payload: 'x'.repeat(6 * 1024 * 1024) }));
  assert.equal((await fs.readdir(tmp)).length, 0);
});

test('CLI rejects unknown and duplicate flags', () => {
  for (const args of [['replay', '--unknown', 'x'], ['compare', '--baseline', 'a', '--baseline', 'b'], ['live', '--live', '--ack', 'wrong', '--unexpected']]) {
    const child = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000, env: {} });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /unknown|duplicate|unrecognized/i);
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-corrective-'));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  const config = { stateDir: path.join(root, 'state'), allowedRoots: [root], maxConcurrent: 2,
    defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60, defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [],
    provider: 'mock', model: 'mock', verification: { commands: [{ id: 'unit', argv: ['/usr/bin/true'], timeoutSeconds: 3, maxOutputBytes: 1000, readOnly: true }], maxSelected: 1 } };
  const manager = await new Manager(config, { PATH: process.env.PATH, HOME: process.env.HOME }, { spawnWorker: false }).init();
  return { root, repository, baseCommit, config, manager, stateDir: path.join(root, 'run-state') };
}

test('live binds canonical contract and effective config with bounded state and poll', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const item = task();
  const input = { manager: f.manager, stateDir: f.stateDir, runId: 'bounded-run', suiteDigest: 'd'.repeat(64), harnessCommit: sha,
    selectedTaskIds: [item.id], tasks: [item], task: item, repository: f.repository, baseCommit: f.baseCommit,
    config: f.config, acknowledgeLive: true };
  await assert.rejects(submitLiveRun({ ...input, baseCommit: 'main' }));
  await assert.rejects(submitLiveRun({ ...input, selectedTaskIds: [item.id, item.id] }));
  assert.equal((await fs.readdir(f.manager.jobsDir)).length, 0);
  const first = await submitLiveRun(input);
  const raw = await f.manager.read(first.jobId);
  assert.deepEqual(raw.verificationIds, ['unit']);
  assert.equal(contractDigest(raw.acceptanceContract), taskContractDigest(item));
  await assert.rejects(submitLiveRun({ ...input, config: { ...f.config, defaultMaxTurns: 3 } }));
  await assert.rejects(pollLiveRun({ manager: f.manager, jobId: first.jobId, timeoutMs: Infinity }));
  const record = (await fs.readdir(f.stateDir)).find(name => name.endsWith('.json'));
  await fs.rm(path.join(f.stateDir, record)); await fs.symlink('/etc/passwd', path.join(f.stateDir, record));
  await assert.rejects(submitLiveRun(input));
});

test('crash-stale lock and lost Manager response reconcile one job under simultaneous callers', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const item = task();
  const input = { manager: f.manager, stateDir: f.stateDir, runId: 'concurrent-run', suiteDigest: 'd'.repeat(64), harnessCommit: sha,
    selectedTaskIds: [item.id], tasks: [item], task: item, repository: f.repository, baseCommit: f.baseCommit,
    config: f.config, acknowledgeLive: true };
  const original = f.manager.start.bind(f.manager); let lost = false;
  f.manager.start = async (...args) => { const value = await original(...args); if (!lost) { lost = true; throw new Error('lost response'); } return value; };
  await assert.rejects(submitLiveRun(input), /lost response/);
  await fs.writeFile(path.join(f.stateDir, `${sha256Hex(input.runId)}.lock`), 'crash-stale');
  const [first, second] = await Promise.all([submitLiveRun(input), submitLiveRun(input)]);
  assert.equal(first.jobId, second.jobId);
  assert.equal((await fs.readdir(f.manager.jobsDir)).length, 1);
  const recovered = await submitLiveRun(input);
  assert.equal(recovered.jobId, first.jobId);
});

test('actual fake Pi Manager yields replayable terminal and incomplete live traces', { timeout: 40_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-fake-pi-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  const fake = path.join(here, 'fixtures', 'harness-runtime-fake-pi.mjs'); await fs.chmod(fake, 0o755);
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ piPath: fake, stateDir: path.join(root, 'state'), allowedRoots: [root],
    provider: 'mock', model: 'mock', maxConcurrent: 2, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 30, defaultMaxTurns: 3,
    queue: { maxPending: 8, maxWaitSeconds: 60, dispatchIntervalMs: 100 },
    verification: { commands: [{ id: 'unit', argv: ['/usr/bin/true'], timeoutSeconds: 3, maxOutputBytes: 1000, readOnly: true }] } }));
  const config = await loadConfig(configFile);
  const manager = await new Manager(config, buildChildEnv(config)).init();
  const item = parseTask({ ...task(), prompt: 'Implement code', expectedEvidence: { ...task().expectedEvidence,
    changedPaths: ['code.txt'] } });
  const submission = await submitLiveRun({ manager, stateDir: path.join(root, 'run-state'), runId: 'fake-pi-run',
    suiteDigest: 'd'.repeat(64), harnessCommit: sha, selectedTaskIds: [item.id], tasks: [item], task: item, repository, baseCommit,
    config, acknowledgeLive: true });
  const incomplete = await pollLiveRun({ manager, jobId: submission.jobId, timeoutMs: 0, task: item, submission,
    runId: 'fake-pi-run', harnessCommit: sha, taskBaseCommit: baseCommit });
  assert.ok(incomplete.trace);
  assert.equal(incomplete.trace.execution.status, 'incomplete');
  const terminal = await pollLiveRun({ manager, jobId: submission.jobId, timeoutMs: 25_000, task: item, submission,
    runId: 'fake-pi-run', harnessCommit: sha, taskBaseCommit: baseCommit });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.trace.verification.contractDigest, taskContractDigest(item));
  assert.equal(terminal.trace.execution.codeDigest, terminal.trace.verification.codeDigest);
  assert.equal(terminal.trace.artifacts.changedPaths.includes('code.txt'), true);
  assert.equal(gradeTask(item, parseTrace(terminal.trace)).taskSuccess, true);
});

test('effective identity includes reasoning defaults and Manager state namespace', () => {
  const base = { piPath: '/bin/true', provider: 'mock', model: 'mock', thinkingLevel: 'low', stateDir: '/tmp/a' };
  assert.notEqual(effectiveConfigFingerprint(base), effectiveConfigFingerprint({ ...base, thinkingLevel: 'high' }));
  assert.notEqual(effectiveConfigFingerprint(base), effectiveConfigFingerprint({ ...base, stateDir: '/tmp/b' }));
});

test('same run ID cannot cross a different harness commit', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const item = task();
  const input = { manager: f.manager, stateDir: f.stateDir, runId: 'source-run', suiteDigest: 'd'.repeat(64), harnessCommit: sha,
    selectedTaskIds: [item.id], tasks: [item], task: item, repository: f.repository, baseCommit: f.baseCommit,
    config: f.config, acknowledgeLive: true };
  await submitLiveRun(input);
  await assert.rejects(submitLiveRun({ ...input, harnessCommit: 'f'.repeat(40) }));
});

test('trace cannot relabel a different Manager request, base, or acceptance contract', async () => {
  const item = task();
  const manager = { status: async () => ({ id: 'job-one', status: 'running', artifacts: null }),
    read: async () => ({ id: 'job-one', requestId: 'other-request', baseCommit: sha, acceptanceContract: null }) };
  await assert.rejects(pollLiveRun({ manager, jobId: 'job-one', timeoutMs: 0, task: item,
    submission: { jobId: 'job-one', requestId: 'expected-request', configFingerprint: fp },
    runId: 'run-one', harnessCommit: sha, taskBaseCommit: sha }));
});

test('deleted source path cannot be reported as preserved', async () => {
  const item = task();
  const manager = { status: async () => ({ id: 'job-one', status: 'completed', execution: { status: 'passed' },
    artifacts: { checkpointComplete: true, inputSnapshotDigest: code } }),
    read: async () => ({ id: 'job-one', requestId: 'req-one', baseCommit: sha, verificationIds: ['unit'],
      acceptanceContract: normalizeAcceptance({ version: 1, required_verification_ids: ['unit'], required_artifact_paths: ['target.txt'], require_review: false }) }),
    artifacts: async () => ({ checkpointComplete: true, inputSnapshotDigest: code, entries: [{ type: 'delete', path: 'base.txt', complete: true, applicable: true, redacted: false }], nextCursor: null }),
    sourcePathExists: async () => true };
  const result = await pollLiveRun({ manager, jobId: 'job-one', timeoutMs: 0, task: item,
    submission: { jobId: 'job-one', requestId: 'req-one', configFingerprint: fp },
    runId: 'run-one', harnessCommit: sha, taskBaseCommit: sha });
  assert.equal(result.trace.artifacts.unchangedPaths.includes('base.txt'), false);
  assert.equal(result.trace.retainedConstraintIds.includes('preserve-base'), false);
});

test('versioned incomplete fixture replays as an observed unknown execution', () => {
  const child = spawnSync(process.execPath, [cli, 'replay', '--fixture', 'incomplete', '--harness-commit', '1'.repeat(40),
    '--task-base-commit', '2'.repeat(40), '--config-fingerprint', 'sha256:' + '3'.repeat(64)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.result.perTask.find(entry => entry.taskId === 'fix-null-check').taskSuccess, false);
  assert.equal(report.observedTaskIds.includes('fix-null-check'), true);
});

test('CLI live fake-Pi bundle replays offline with identical graded result', { timeout: 45_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-cli-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.dirname(here), evaluationRoot = path.join(root, 'evaluation'), repository = path.join(root, 'task');
  await fs.mkdir(evaluationRoot); await fs.mkdir(repository);
  for (const name of ['src', 'evals', 'scripts', 'internal-agent', 'package.json'])
    await fs.cp(path.join(sourceRoot, name), path.join(evaluationRoot, name), { recursive: true });
  await fs.symlink(path.join(sourceRoot, 'node_modules'), path.join(evaluationRoot, 'node_modules'));
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  for (const dir of [evaluationRoot, repository]) {
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'test@example.invalid'); git(dir, 'config', 'user.name', 'Test');
  }
  git(evaluationRoot, 'add', 'src', 'evals', 'scripts', 'internal-agent', 'package.json');
  git(evaluationRoot, 'commit', '-qm', 'isolated test checkout');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'base');
  const baseCommit = git(repository, 'rev-parse', 'HEAD');
  const fake = path.join(here, 'fixtures', 'harness-runtime-fake-pi.mjs'); await fs.chmod(fake, 0o755);
  const configFile = path.join(root, 'config.json'), bundleFile = path.join(root, 'bundle.json');
  await fs.writeFile(configFile, JSON.stringify({ piPath: fake, stateDir: path.join(root, 'state'), allowedRoots: [root],
    provider: 'mock', model: 'mock', maxConcurrent: 2, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 30, defaultMaxTurns: 3,
    queue: { maxPending: 8, maxWaitSeconds: 60, dispatchIntervalMs: 100 },
    verification: { commands: [{ id: 'lint', argv: ['/usr/bin/true'], timeoutSeconds: 3, maxOutputBytes: 1000, readOnly: true }] } }));
  const command = path.join(evaluationRoot, 'scripts', 'evaluate-harness.mjs');
  const live = spawnSync(process.execPath, [command, 'live', '--live', '--ack', 'I-UNDERSTAND-THIS-SUBMITS-TO-THE-CONFIGURED-PI-MCP-MANAGER',
    '--run-id', 'cli-live-run', '--select', 'fix-null-check', '--repository', repository, '--base-commit', baseCommit,
    '--state-dir', path.join(root, 'run-state'), '--config', configFile, '--out', bundleFile], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(live.status, 0, live.stderr);
  const bundle = JSON.parse(await fs.readFile(bundleFile, 'utf8'));
  assert.equal(bundle.traces.length, 1);
  assert.equal(bundle.traces[0].execution.status, 'completed');
  const replay = spawnSync(process.execPath, [command, 'replay', '--traces', bundleFile, '--origin', 'live',
    '--select', 'fix-null-check', '--harness-commit', git(evaluationRoot, 'rev-parse', 'HEAD'),
    '--task-base-commit', baseCommit, '--config-fingerprint', bundle.traces[0].configFingerprint], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout).result, bundle.report.result);
});
