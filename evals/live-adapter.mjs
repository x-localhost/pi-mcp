// Live execution adapter. Pins a run's identity (suite digest, task
// selection, repository, committed base ref and secret-free config
// fingerprint) plus each task's own content to a stable runId, so that a
// retried or restarted submission reconciles to the same Manager job instead
// of creating a duplicate, and so that a changed config or task selection
// under the same runId is rejected before the Manager is ever contacted.
//
// Returns only a small, explicitly constructed, allowlisted evidence object
// -- never the full Manager job record -- and never performs an automatic
// review attestation, approval or commit of any kind.

import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from './util.mjs';
import { taskContentDigest } from './schema.mjs';
import { ProvenanceError } from './errors.mjs';

const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running', 'finalizing']);
const LOCK_TIMEOUT_MS = 5000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withRunLock(stateDir, runId, fn) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(stateDir, `${sha256Hex(runId)}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await (await fs.open(lockFile, 'wx')).close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Run state lock timed out');
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lockFile).catch(() => {});
  }
}

function recordFile(stateDir, runId) {
  return path.join(stateDir, `${sha256Hex(runId)}.json`);
}

async function readRunRecord(stateDir, runId) {
  try {
    return JSON.parse(await fs.readFile(recordFile(stateDir, runId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeRunRecord(stateDir, runId, record) {
  const file = recordFile(stateDir, runId);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}

function runIdentityDigest({ suiteDigest, selectedTaskIds, repository, baseCommit, configFingerprint }) {
  return sha256Hex({ suiteDigest, selectedTaskIds: [...selectedTaskIds].sort(), repository, baseCommit, configFingerprint });
}

export async function submitLiveRun({
  manager, stateDir, runId, suiteDigest, selectedTaskIds, task,
  repository, baseCommit, configFingerprint, provider, model, acknowledgeLive,
}) {
  if (acknowledgeLive !== true) throw new Error('Live execution requires explicit acknowledgeLive=true');
  if (!Array.isArray(selectedTaskIds) || !selectedTaskIds.includes(task.id)) {
    throw new Error(`Task "${task.id}" is not part of the selected task set for this run`);
  }
  const identity = runIdentityDigest({ suiteDigest, selectedTaskIds, repository, baseCommit, configFingerprint });
  const contentDigest = taskContentDigest(task);
  const requestId = `eval-${sha256Hex(`${runId}:${task.id}`).slice(0, 48)}`;

  return withRunLock(stateDir, runId, async () => {
    const existing = await readRunRecord(stateDir, runId);
    if (existing && existing.identity !== identity) {
      throw new ProvenanceError('Run identity changed under the same runId: suite digest, task selection, repository, baseCommit and configFingerprint must stay fixed for a given runId');
    }
    const record = existing ?? { runId, identity, tasks: {} };
    const existingTask = record.tasks[task.id];
    if (existingTask && existingTask.contentDigest !== contentDigest) {
      throw new ProvenanceError(`Task "${task.id}" content changed under the same run/task identity`);
    }
    // Persist before submitting, so a crash between here and the Manager
    // response still leaves a trail; a lost response is reconciled on retry
    // because the request_id below is derived deterministically and the
    // Manager itself is idempotent for a repeated request_id.
    record.tasks[task.id] = { requestId, contentDigest, jobId: existingTask?.jobId ?? null };
    await writeRunRecord(stateDir, runId, record);

    const started = await manager.start({ repository, title: task.id, prompt: task.prompt, request_id: requestId, provider, model, base_ref: baseCommit });

    record.tasks[task.id].jobId = started.id;
    await writeRunRecord(stateDir, runId, record);

    return { runId, taskId: task.id, jobId: started.id, requestId, status: started.status, origin: 'live' };
  });
}

export async function pollLiveRun({ manager, jobId, timeoutMs = 30000 }) {
  const until = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const current = await manager.status(jobId, 0);
    if (!ACTIVE_STATUSES.has(current.status) || Date.now() >= until) {
      return { jobId, status: current.status, finishedAt: current.finishedAt ?? null, error: current.error ?? null };
    }
    await sleep(Math.max(0, Math.min(250, until - Date.now())));
  }
}
