import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as C } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withOwnershipLock } from '../src/ownership.mjs';
import { normalizeAcceptance, contractDigest } from '../src/acceptance.mjs';
import { sha256Hex, GIT_SHA, HEX64 } from './util.mjs';
import { parseTask, parseTrace, taskContentDigest, taskContractDigest } from './schema.mjs';
import { ProvenanceError } from './errors.mjs';

const exec = promisify(execFile);
const ACTIVE = new Set(['queued', 'starting', 'running', 'finalizing']);
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const STATE_LIMIT = 65536;
const POLL_LIMIT_MS = 30000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function effectiveConfigFingerprint(config, provider, model) {
  if (!config || typeof config !== 'object') throw new Error('Effective config required');
  const fields = ['piPath','piArgs','stateDir','allowedRoots','thinkingLevel','defaultTimeoutSeconds','maxTimeoutSeconds','defaultMaxTurns','maxConcurrent',
    'allowedCommands','envAllowlist','agentDir','modelsFile','network','queue','verification','budgets','retention','artifacts','offlineMaterials','approvedMcp','context','observation'];
  const projected = Object.fromEntries(fields.map(key => [key, config[key] ?? null]));
  return 'sha256:' + sha256Hex({ ...projected, provider: provider ?? config.provider ?? null, model: model ?? config.model ?? null });
}
function selectedTasks(ids, tasks, task) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 || new Set(ids).size !== ids.length) throw new Error('Invalid selected task IDs');
  const parsed = (tasks ?? [task]).map(parseTask);
  if (parsed.length !== ids.length || new Set(parsed.map(item => item.id)).size !== parsed.length ||
    ids.some(id => !parsed.some(item => item.id === id)) || !parsed.some(item => item.id === task?.id &&
      taskContentDigest(item) === taskContentDigest(parseTask(task)))) throw new Error('Complete selected task content required');
  return parsed;
}
function requestId(runId, taskId) { return 'eval-' + sha256Hex(runId + ':' + taskId).slice(0, 48); }
function payload(task, repository, baseCommit, provider, model, rid) {
  return { repository, title: task.id, prompt: task.prompt, request_id: rid, provider, model, base_ref: baseCommit,
    verification_ids: task.expectedEvidence.requiredVerifierIds,
    acceptance: normalizeAcceptance({ version: 1, required_verification_ids: task.expectedEvidence.requiredVerifierIds,
      required_artifact_paths: task.expectedEvidence.changedPaths, require_review: task.expectedEvidence.requiresReview }) };
}
async function validateBase(repository, commit) {
  if (typeof repository !== 'string' || !path.isAbsolute(repository) || !GIT_SHA.test(commit || '')) throw new Error('Absolute repository and committed base SHA required');
  const { stdout } = await exec('git', ['-C', repository, 'rev-parse', '--verify', commit + '^{commit}'], { timeout: 5000, maxBuffer: 1024 });
  if (stdout.trim() !== commit) throw new Error('Base commit mismatch');
}
async function privateDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Absolute stateDir required');
  const parent = await fs.lstat(path.dirname(dir));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe state parent');
  try { await fs.mkdir(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('Unsafe state directory');
}
async function readRecord(file) {
  let h;
  try { h = await fs.open(file, C.O_RDONLY | C.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = await h.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || before.size < 2 || before.size > STATE_LIMIT || (before.mode & 0o077)) throw new Error('Unsafe run state');
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) { const read = await h.read(data, offset, data.length - offset, offset); if (!read.bytesRead) throw new Error('Run state changed'); offset += read.bytesRead; }
    const extra = Buffer.alloc(1);
    if ((await h.read(extra, 0, 1, before.size)).bytesRead) throw new Error('Run state grew during read');
    const after = await h.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Run state changed');
    const record = JSON.parse(data.toString('utf8'));
    if (!record || record.version !== 1 || !RUN_ID.test(record.runId || '') || !HEX64.test(record.identity || '') ||
      !record.tasks || typeof record.tasks !== 'object' || Array.isArray(record.tasks) || Object.keys(record.tasks).length > 16 ||
      Object.keys(record).some(key => !['version','runId','identity','tasks'].includes(key))) throw new Error('Corrupt run state');
    for (const [id, item] of Object.entries(record.tasks)) {
      if (!/^[a-z][a-z0-9-]{2,63}$/.test(id) || !item || typeof item !== 'object' ||
        Object.keys(item).some(key => !['requestId','contentDigest','jobId'].includes(key)) ||
        !/^eval-[0-9a-f]{48}$/.test(item.requestId || '') || !HEX64.test(item.contentDigest || '') ||
        item.jobId !== null && !RUN_ID.test(item.jobId || '')) throw new Error('Corrupt task state');
    }
    return record;
  } finally { await h.close(); }
}
async function writeRecord(file, record) {
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > STATE_LIMIT) throw new Error('Run state too large');
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID());
  const h = await fs.open(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
  await fs.rename(temp, file);
  const dir = await fs.open(path.dirname(file), C.O_RDONLY | C.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function submitLiveRun({ manager, stateDir, runId, suiteDigest, selectedTaskIds, tasks, task,
  repository, baseCommit, harnessCommit, config, configFingerprint, provider, model, acknowledgeLive }) {
  if (acknowledgeLive !== true) throw new Error('Live execution requires explicit acknowledgeLive=true');
  if (!RUN_ID.test(runId || '') || !HEX64.test(suiteDigest || '') || !GIT_SHA.test(harnessCommit || '')) throw new Error('Invalid run identity');
  const selected = selectedTasks(selectedTaskIds, tasks, task);
  await validateBase(repository, baseCommit);
  const actual = config ?? manager?.config;
  const effectiveProvider = provider ?? actual?.provider, effectiveModel = model ?? actual?.model;
  const fingerprint = effectiveConfigFingerprint(actual, effectiveProvider, effectiveModel);
  if (configFingerprint !== undefined && configFingerprint !== fingerprint) throw new ProvenanceError('Supplied config fingerprint differs from effective config');
  const submissions = selectedTaskIds.map(id => payload(selected.find(item => item.id === id), repository, baseCommit, effectiveProvider, effectiveModel, requestId(runId, id)));
  const identity = sha256Hex({ suiteDigest, harnessCommit, selectedTaskIds: [...selectedTaskIds].sort(),
    taskContent: selected.map(item => [item.id, taskContentDigest(item)]).sort(), submissions, repository, baseCommit, fingerprint });
  // The caller's output location cannot select a new registry for the same Manager.
  if (stateDir !== undefined && (typeof stateDir !== 'string' || !path.isAbsolute(stateDir))) throw new Error('Absolute stateDir required');
  const registry = path.join(manager.config.stateDir, 'evaluation-runs');
  await privateDir(registry);
  const file = path.join(registry, sha256Hex(runId) + '.json');
  return withOwnershipLock(file + '.lock', async () => {
    const existing = await readRecord(file);
    if (existing && (existing.runId !== runId || existing.identity !== identity)) throw new ProvenanceError('Run identity changed');
    const record = existing ?? { version: 1, runId, identity, tasks: {} };
    const old = record.tasks[task.id], digest = taskContentDigest(task), rid = requestId(runId, task.id);
    if (old && (old.contentDigest !== digest || old.requestId !== rid)) throw new ProvenanceError('Task identity changed');
    record.tasks[task.id] = { requestId: rid, contentDigest: digest, jobId: old?.jobId ?? null };
    await writeRecord(file, record);
    // Manager request-id tombstones are authoritative, including after cleanup.
    const started = await manager.start(payload(task, repository, baseCommit, effectiveProvider, effectiveModel, rid));
    record.tasks[task.id].jobId = started.id;
    await writeRecord(file, record);
    return { runId, taskId: task.id, jobId: started.id, requestId: rid, status: started.status, origin: 'live', configFingerprint: fingerprint };
  }, { timeoutSeconds: 10 });
}
async function changedEvidence(manager, id, digest) {
  let cursor = null, pages = 0;
  const paths = [], filePaths = [];
  do {
    const page = await manager.artifacts(id, { cursor, limit: 100 });
    if (!page.checkpointComplete || page.inputSnapshotDigest !== digest || page.truncated || page.omissionsTruncated) return null;
    for (const entry of page.entries) if (entry.type === 'file' || entry.type === 'delete') {
      if (entry.redacted || entry.complete !== true || entry.applicable !== true || typeof entry.path !== 'string') return null;
      paths.push(entry.path);
      if (entry.type === 'file') filePaths.push(entry.path);
    }
    cursor = page.nextCursor;
    if (++pages > 42 || paths.length > 4096) return null;
  } while (cursor !== null);
  return { changedPaths: [...new Set(paths)], filePaths: [...new Set(filePaths)] };
}
async function resumeEvidence(manager, jobId, required, active) {
  if (typeof manager.events !== 'function') return { resumeEvents: [], eventsTruncated: required || active };
  let cursor = 0, gap = false, complete = false;
  const resumeEvents = [];
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await manager.events(jobId, { cursor, limit: 100 });
    if (page.gap || page.dropped > 0) gap = true;
    for (const event of page.events) if (typeof event.requestId === 'string' && typeof event.jobId === 'string') {
      if (resumeEvents.length >= 64) { gap = true; break; }
      resumeEvents.push({ eventId: 'e' + event.cursor, requestId: event.requestId, jobId: event.jobId });
    }
    if (page.nextCursor >= page.latestCursor) { complete = true; break; }
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor) { gap = true; break; }
    cursor = page.nextCursor;
  }
  return { resumeEvents, eventsTruncated: gap || !complete || active || required && resumeEvents.length === 0 };
}
async function makeTrace(manager, current, { jobId, task, submission, runId, harnessCommit, taskBaseCommit }) {
  const raw = await manager.read(jobId);
  if (raw.id !== jobId || current.id && current.id !== jobId || raw.requestId !== submission.requestId ||
    raw.baseCommit !== taskBaseCommit || contractDigest(raw.acceptanceContract) !== taskContractDigest(task) ||
    task.expectedEvidence.requiredVerifierIds.some(id => !raw.verificationIds?.includes(id)))
    throw new ProvenanceError('Manager job does not match submitted task contract or provenance');
  const digest = current.artifacts?.checkpointComplete && HEX64.test(current.artifacts?.inputSnapshotDigest || '') ? current.artifacts.inputSnapshotDigest : null;
  const status = digest && !ACTIVE.has(current.status) ? current.status === 'completed' && current.execution?.status === 'passed' ? 'completed' : 'failed' : 'incomplete';
  const evidence = digest && !ACTIVE.has(current.status) ? await changedEvidence(manager, jobId, digest) : null;
  const changed = evidence?.changedPaths ?? null;
  let present = evidence ? [] : null;
  if (present) for (const rel of task.expectedEvidence.changedPaths) {
    if (evidence.filePaths.includes(rel) && await manager.sourcePathExists(raw, rel)) present.push(rel);
  }
  let unchanged = changed === null ? null : [];
  if (unchanged) for (const { path: rel } of task.expectedEvidence.constraintEvidence) {
    if (changed.includes(rel)) continue;
    if (!await manager.sourcePathExists(raw, rel)) { unchanged = null; break; }
    unchanged.push(rel);
  }
  const retained = unchanged === null ? null : task.expectedEvidence.constraintEvidence.filter(item => unchanged.includes(item.path)).map(item => item.constraintId);
  const required = task.expectedEvidence.requiredVerifierIds;
  const verified = digest && raw.verification?.status === 'passed' && raw.verification.verifiedSnapshotDigest === digest &&
    required.every(id => raw.verificationIds?.includes(id) && raw.verification.commands?.some(command => command.id === id && command.status === 'passed'));
  const verification = verified ? { jobId, codeDigest: digest, contractDigest: taskContractDigest(task), verifierIds: [...required], status: 'passed' } : null;
  let review = null;
  if (digest && task.expectedEvidence.requiresReview && current.acceptance?.status === 'accepted') {
    const item = (raw.reviewAttestations || []).filter(entry => entry.authority === 'caller' && entry.sourceJobId === jobId &&
      entry.inputSnapshotDigest === digest && entry.contractDigest === taskContractDigest(task)).at(-1);
    if (item && item.reviewJobId && item.reviewJobId !== jobId && ['approved','rejected'].includes(item.verdict))
      review = { jobId, reviewJobId: item.reviewJobId, codeDigest: digest, contractDigest: taskContractDigest(task), verdict: item.verdict };
  }
  const availability = current.usageAvailability || {};
  const responses = Number.isInteger(availability.observedResponses) ? Math.min(100000, Math.max(0, availability.observedResponses)) : 0;
  const tokens = availability.totalTokens === true && responses > 0 ? [current.usage?.totalTokens,current.usage?.total].find(n => Number.isFinite(n) && n >= 0) ?? null : null;
  const cost = availability.costUsd === true && responses > 0 && Number.isFinite(current.usage?.cost?.total) && current.usage.cost.total >= 0 ? current.usage.cost.total : null;
  const started = Date.parse(current.startedAt || ''), finished = Date.parse(current.finishedAt || '');
  const resume = await resumeEvidence(manager, jobId, task.expectedEvidence.requiresResume, ACTIVE.has(current.status));
  return parseTrace({ taskId: task.id, runId, origin: 'live', harnessCommit, taskBaseCommit,
    configFingerprint: submission.configFingerprint,
    execution: { jobId, status, codeDigest: status === 'incomplete' ? null : digest },
    artifacts: { changedPaths: changed, unchangedPaths: unchanged, presentPaths: present }, verification, review, retainedConstraintIds: retained,
    ...resume,
    timing: Number.isFinite(started) && Number.isFinite(finished) && finished >= started && finished - started <= 86400000 ? { durationMs: finished - started } : null,
    usageAvailability: { totalTokens: tokens === null ? 'unavailable' : 'available', costUsd: cost === null ? 'unavailable' : 'available' },
    usage: { totalTokens: tokens, costUsd: cost, observedResponses: responses } });
}
export async function pollLiveRun({ manager, jobId, timeoutMs = POLL_LIMIT_MS, task, submission, runId, harnessCommit, taskBaseCommit }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > POLL_LIMIT_MS) throw new Error('Invalid bounded poll timeout');
  const until = Date.now() + timeoutMs;
  let current;
  do {
    current = await manager.status(jobId, 0);
    if (!ACTIVE.has(current.status) || Date.now() >= until) break;
    await delay(Math.max(1, Math.min(250, until - Date.now())));
  } while (true);
  const result = { jobId, status: current.status, finishedAt: current.finishedAt ?? null, error: current.error ?? null };
  if (task !== undefined) {
    if (!submission || submission.jobId !== jobId || !RUN_ID.test(runId || '') || !GIT_SHA.test(harnessCommit || '') ||
      !GIT_SHA.test(taskBaseCommit || '')) throw new Error('Trace provenance required');
    result.trace = await makeTrace(manager, current, { jobId, task: parseTask(task), submission, runId, harnessCommit, taskBaseCommit });
  }
  return result;
}
