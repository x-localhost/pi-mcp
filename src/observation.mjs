import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const DEFAULT = Object.freeze({ maxEvents: 256, maxBytes: 65_536, idleTimeoutMs: 0, consecutiveFailureLimit: 0 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function normalizeObservation(raw) {
  if (raw === undefined) return { ...DEFAULT };
  if (!object(raw) || Object.keys(raw).some(key => !Object.hasOwn(DEFAULT, key))) throw new Error('Invalid observation configuration');
  const value = { ...DEFAULT, ...raw };
  for (const [key, min, max] of [['maxEvents', 1, 1024], ['maxBytes', 1024, 262_144], ['idleTimeoutMs', 0, 3_600_000], ['consecutiveFailureLimit', 0, 100]]) if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error('Invalid observation configuration');
  return value;
}

async function atomic(file, value) {
  if (!file) return;
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

async function atomicText(file, value) {
  if (!file) return;
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, value, { mode: 0o600, flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

const KINDS = new Set(['heartbeat', 'tool_start', 'tool_end', 'provider_request', 'provider_response', 'provider_retry', 'compaction', 'context_reduction', 'agent_start', 'agent_end']);
const CATEGORIES = new Set(['ok', 'auth', 'rate_limit', 'timeout', 'tls', 'connect', 'protocol', 'upstream', 'tool', 'denied']);
export function createObservation({ observationFile, activityFile, stopFile, jobId, policy: rawPolicy, onStop } = {}) {
  const policy = normalizeObservation(rawPolicy);
  const entries = [];
  const started = new Date().toISOString();
  const state = { version: 1, lastEventAt: started, lastProgressAt: started, consecutiveToolFailures: 0, lastKind: 'agent_start' };
  let queue = Promise.resolve();
  let stopped = false;
  const record = (kind, input = {}) => {
    queue = queue.then(async () => {
      if (!KINDS.has(kind)) throw new Error('Invalid observation event');
      const at = new Date().toISOString();
      const event = { version: 1, id: randomUUID(), kind, at };
      if (typeof jobId === 'string' && /^[0-9a-f-]{36}$/i.test(jobId)) event.jobId = jobId;
      if (typeof input.toolName === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.toolName)) event.toolName = input.toolName;
      for (const key of ['toolId', 'requestId', 'attemptId']) if (typeof input[key] === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input[key])) event[key] = input[key];
      if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) event.durationMs = Math.min(120_000, Math.max(0, Math.floor(input.durationMs)));
      if (typeof input.isError === 'boolean') event.isError = input.isError;
      if (typeof input.category === 'string' && CATEGORIES.has(input.category)) event.category = input.category;
      if (Number.isInteger(input.droppedMessages) && input.droppedMessages >= 0) event.droppedMessages = Math.min(input.droppedMessages, 100_000);
      if (kind === 'compaction' && ['started', 'completed', 'failed'].includes(input.outcome)) event.outcome = input.outcome;
      if (kind === 'provider_retry' && ['rate_limit', 'timeout', 'upstream'].includes(input.retryReason)) event.retryReason = input.retryReason;
      entries.push(event);
      while (entries.length > policy.maxEvents || Buffer.byteLength(entries.map(item => JSON.stringify(item)).join('\n') + '\n') > policy.maxBytes) entries.shift();
      if (observationFile) await atomicText(observationFile, entries.map(item => JSON.stringify(item)).join('\n') + '\n');
      state.lastEventAt = at;
      state.lastKind = kind;
      if (kind === 'tool_end') {
        state.consecutiveToolFailures = input.isError === true ? state.consecutiveToolFailures + 1 : 0;
        if (input.isError !== true) state.lastProgressAt = at;
      } else if (['agent_start', 'agent_end', 'context_reduction', 'compaction'].includes(kind)) state.lastProgressAt = at;
      if (activityFile) await atomic(activityFile, state);
      if (!stopped && policy.consecutiveFailureLimit && state.consecutiveToolFailures >= policy.consecutiveFailureLimit) await stop('repeated_tool_failure');
      return event;
    });
    return queue;
  };
  const stop = async reason => {
    if (stopped) return;
    if (!['idle', 'repeated_tool_failure', 'context_limit'].includes(reason)) throw new Error('Invalid stop reason');
    stopped = true;
    const value = { version: 1, reason, at: new Date().toISOString() };
    if (stopFile) await atomic(stopFile, value);
    onStop?.(reason);
  };
  return { record, stop, snapshot: () => ({ ...state }), flush: () => queue };
}
