import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RpcClient } from './rpc.mjs';
import { atomicJson, git } from './manager.mjs';
import { sanitize } from './sanitize.mjs';
import { validateProviderHeaders, collectHeaderSecrets, collectConfigSecrets } from './headers.mjs';
import { processIdentity, stopOwnedGroup, groupState } from './ownership.mjs';
import { snapshotArtifacts, attachArtifactReport } from './artifacts.mjs';
import { runVerifier, evaluateVerification, reconcileFinalSnapshot } from './verification.mjs';
import { appendJobEvent } from './events.mjs';
import { normalizeImages, modelSupportsImages } from './images.mjs';
import { POLICY_READY_TIMEOUT_MS } from './approved-mcp.mjs';
import { extendAuthoritativeInstructions } from './session-transition.mjs';
import { classifyFinalMessage, recoveryDelayMs } from './provider-recovery.mjs';

process.umask(0o077);
const exec = promisify(execFile);
const dir = process.argv[2];
const jobFile = path.join(dir, 'job.json');
let job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
const runtime = JSON.parse(await fs.readFile(path.join(dir, 'runtime.json'), 'utf8'));
const providerRecoveryPolicy = runtime.providerRecovery || { maxAttempts: 2, baseDelayMs: 5000, maxDelayMs: 60000 };
const CONTINUATION_PROMPT = 'The previous response was empty or malformed. Continue the task from the current state of the worktree without repeating steps that are already finished, and end your reply with a short summary.';
let saveChain = Promise.resolve();
const save = () => { const snapshot = structuredClone(job); saveChain = saveChain.then(() => atomicJson(jobFile, snapshot)); return saveChain; };
const now = () => new Date().toISOString();
const sessionRoot = await fs.realpath(job.sessionDir);
let child, rpc, stopping, finalText = '', settled = false, piActive = false, finalStopReason, providerError = '', stderrChunks = [], stderrBytes = 0, stderrOverflow = false;
// lastPromptAt: set whenever a prompt (initial or continuation) is sent to
// Pi, so the idle check below can tell a freshly-started run apart from one
// whose only progress evidence predates a provider-recovery backoff (which
// can itself be longer than idleTimeoutMs). recoveryWaiting: true only
// while run() is inside the bounded backoff before a guaranteed-next
// continuation prompt, so pumpControls() can accept a steer during that
// specific window (Pi queues it regardless of run state; see
// docs/provider-resilience.md) without doing so once the run has otherwise
// settled for good (healthy or recovery-exhausted) and no further prompt
// will ever be sent.
let lastPromptAt = null, recoveryWaiting = false;
let eventChain = Promise.resolve(), usageBaseline = null, stopPromise, lastAssistantMessage = null;
const seenObservationIds = new Set();
const secretValues = [];
secretValues.push(...(runtime.approvedMcp?.servers || []).flatMap(server => Object.values(server.env || {}).filter(value => typeof value === 'string' && value)));
const refreshSecrets = async () => {
  const configs = {};
  // collectConfigSecrets() is the shared walk (src/headers.mjs); a value
  // reached through a "headers" map is treated as secret regardless of
  // length (even 1-5 characters), since arbitrary custom header names cannot
  // be recognized by its generic token/key/secret/... name pattern. It stays
  // inside the per-file try so a collector failure is contained per file.
  for (const name of ['auth.json', 'models.json']) {
    try { configs[name] = JSON.parse(await fs.readFile(path.join(runtime.agentDir, name), 'utf8')); secretValues.push(...collectConfigSecrets([configs[name]], process.env)); } catch {}
  }
  secretValues.push(...collectHeaderSecrets(configs['models.json'], configs['auth.json'], process.env));
};
await refreshSecrets();
const clean = value => sanitize(value, process.env, secretValues);
// Events contain protocol metadata only. Sanitizing the entire record would
// corrupt cursor controls and enum statuses for short configured secrets.
const emitEvent = event => { eventChain = eventChain.then(() => appendJobEvent(dir, event)).catch(() => {}); return eventChain; };
const checkBudget = () => {
  const budget = runtime.budgets || {}, result = job.usage || {};
  const input = (result.input || 0) + (result.cacheRead || 0) + (result.cacheWrite || 0);
  const output = result.output || 0;
  const total = Math.max(input + output, result.totalTokens || 0, result.total || 0);
  const cost = typeof result.cost?.total === 'number' ? result.cost.total : null;
  if (budget.maxInputTokens && input >= budget.maxInputTokens || budget.maxOutputTokens && output >= budget.maxOutputTokens || budget.maxTotalTokens && total >= budget.maxTotalTokens || budget.maxCostUsd && cost !== null && cost >= budget.maxCostUsd) {
    job.budget = { status: 'observed_limit', inputTokens: input, outputTokens: output, costUsd: cost, inFlightOvershootPossible: true };
    stop('budget_limit').catch(() => {});
  }
};
const addUsage = usage => {
  const invalid = usage && typeof usage === 'object' && Object.entries(usage).some(([key, value]) => key === 'cost' ? value && typeof value === 'object' && Object.values(value).some(amount => typeof amount === 'number' && (!Number.isFinite(amount) || amount < 0))
    : typeof value === 'number' && (!Number.isFinite(value) || value < 0));
  const measured = value => Number.isFinite(value) && value >= 0;
  const components = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const componentTotal = components.every(key => measured(usage?.[key])) ? components.reduce((sum, key) => sum + usage[key], 0) : null;
  const tokenTotal = [usage?.totalTokens, usage?.total, componentTotal].find(value => measured(value) && value > 0) ?? null;
  const available = job.usageAvailability || { totalTokens: true, costUsd: true, observedResponses: 0 };
  available.observedResponses = Math.min(1_000_000, available.observedResponses + 1);
  available.totalTokens = available.totalTokens && !invalid && tokenTotal > 0 && available.observedResponses < 1_000_000;
  available.costUsd = available.costUsd && !invalid && measured(usage?.cost?.total) && usage.cost.total > 0 && available.observedResponses < 1_000_000;
  job.usageAvailability = available;
  if (!usage || typeof usage !== 'object') return;
  if (invalid) {
    if (Object.keys(runtime.budgets || {}).length) { job.budget = { status: 'unavailable', reason: 'Invalid measured usage from provider', inFlightOvershootPossible: true }; stop('budget_unavailable').catch(() => {}); }
    return;
  }
  const previous = job.usage || {};
  const result = { ...previous };
  for (const [key, value] of Object.entries(usage)) {
    if (key === 'cost' && value && typeof value === 'object') {
      result.cost = { ...(result.cost || {}) };
      for (const [costKey, amount] of Object.entries(value)) if (typeof amount === 'number') result.cost[costKey] = (result.cost[costKey] || 0) + amount;
    } else if (typeof value === 'number') result[key] = (result[key] || 0) + value;
  }
  job.usage = result;
  checkBudget();
};
const writePrivate = (name, text) => fs.writeFile(path.join(dir, name), clean(text), { mode: 0o600 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Resolves once Pi has either emitted agent_settled or actually exited, or
// `timeoutMs` has elapsed, whichever comes first. Used by stop() to give Pi a
// bounded chance to finish processing `abort` (and write its own terminal
// session state) before its process group is signalled.
function waitForSettledOrExit(timeoutMs) {
  return new Promise(resolve => {
    if (settled || child.exitCode !== null || timeoutMs <= 0) { resolve(); return; }
    let timer;
    const done = () => { clearTimeout(timer); rpc.off('agent_settled', done); child.off('exit', done); resolve(); };
    timer = setTimeout(done, timeoutMs);
    rpc.once('agent_settled', done);
    child.once('exit', done);
  });
}
async function stop(reason) {
  if (stopping) return stopPromise;
  stopping = reason;
  // Assign the whole stop sequence to stopPromise synchronously (before any
  // await below), not just its final stopOwnedGroup call. run()'s own
  // `stopping`-polling loop can notice `stopping` and let finalize() proceed
  // within ~100ms, well before the grace wait below completes; finalize()
  // must await this same promise (see finalizeOnce()) so it never races a
  // signal against Pi's own graceful shutdown.
  stopPromise = (async () => {
    job.lastProgress = `Stopping: ${reason}`; await save();
    if (rpc && child?.exitCode === null) {
      await rpc.request('clear_queue', {}, 1000).catch(() => {});
      const graceDeadline = Date.now() + 2000;
      await rpc.request('abort', {}, 2000).catch(() => {});
      // Pi needs a chance to actually process the abort (finish its current
      // write, emit an aborted assistant message) before its process group
      // is signalled; killing it right after merely queuing the abort
      // request raced it against delivery and could leave a partial session
      // write with no `aborted` message. Bounded so a Pi that never settles
      // or exits does not block the overall stop/cancel path indefinitely.
      if (child.exitCode === null) await waitForSettledOrExit(Math.max(0, graceDeadline - Date.now()));
    }
    // null: no Pi identity yet; finalize() then stops the group itself if Pi spawned later.
    return job.piIdentity ? stopOwnedGroup(job.piIdentity, 1500).catch(() => ({ state: 'ambiguous' })) : null;
  })();
  return stopPromise;
}
async function inventory() {
  try {
    const [diffStat, tracked, untracked] = await Promise.all([
      git(job.worktree, ['diff', '--stat', job.baseCommit]),
      git(job.worktree, ['diff', '--name-only', '-z', job.baseCommit], true),
      git(job.worktree, ['ls-files', '--others', '--exclude-standard', '-z'], true),
    ]);
    job.diffStat = clean(diffStat).slice(0, 8000);
    job.changedFiles = [...tracked.split('\0').filter(Boolean).map(file => ({ path: clean(file), kind: 'tracked' })),
      ...untracked.split('\0').filter(Boolean).map(file => ({ path: clean(file), kind: 'untracked' }))].slice(0, 200);
    try {
      const patch = await git(job.worktree, ['diff', '--no-ext-diff', '--no-binary', job.baseCommit], true);
      const safe = clean(patch);
      job.diffPreviewTruncated = Buffer.byteLength(safe) > 2 * 1024 * 1024;
      if (!job.diffPreviewTruncated) await fs.writeFile(path.join(dir, 'changes.patch'), safe, { mode: 0o600 });
    } catch { job.diffPreviewTruncated = true; }
  } catch (error) { job.diffStat = `Inventory unavailable: ${clean(error.message)}`; }
}
async function verifySession(file, requireExisting = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Pi did not provide an absolute session file');
  const normalized = path.resolve(file);
  if (!normalized.startsWith(sessionRoot + path.sep)) throw new Error('Pi session path escaped isolated session directory');
  const existing = await fs.realpath(normalized).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (requireExisting && !existing) throw new Error('Pi session file unavailable');
  if (existing && !existing.startsWith(sessionRoot + path.sep)) throw new Error('Pi session symlink escaped isolated directory');
  return existing || normalized;
}
async function run() {
  job.workerPid = process.pid; job.workerIdentity = await processIdentity(); job.status = 'running'; job.execution = { status: 'running' };
  job.verification = { status: job.verificationIds?.length ? 'pending' : 'not_requested', commands: [] };
  job.startedAt = now(); job.heartbeatAt = now(); await save(); await emitEvent({ type: 'status', status: 'running' });
  const { stdout: version } = await exec(runtime.piPath, [...runtime.piArgs, '--version'], { timeout: 10000, env: process.env });
  if (!/\b1\.4\.0\b/.test(version)) throw new Error(`Unsupported Pi version: ${version.trim()}`);
  if (stopping) throw new Error(`Stopped during startup: ${stopping}`);
  // Revalidate owned header configuration against this process's own forwarded
  // environment right before spawning Pi, since the environment could differ
  // from whatever Manager.start() observed earlier for this job.
  const readOwnedJson = async (name, required) => {
    let content;
    try { content = await fs.readFile(path.join(runtime.agentDir, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' && !required) return null; throw new Error(`Invalid owned ${name} configuration`); }
    try { return JSON.parse(content); } catch { throw new Error(`Invalid owned ${name} configuration`); }
  };
  validateProviderHeaders({ modelsConfig: await readOwnedJson('models.json', runtime.ownedModelsRequired), authConfig: await readOwnedJson('auth.json', runtime.ownedAuthRequired),
    provider: job.provider, model: job.model, childEnv: process.env });
  const nonce = randomUUID(); const readyFile = path.join(dir, 'policy-ready.json');
  const policyFile = path.join(dir, 'policy.json');
  await atomicJson(policyFile, { nonce, readyFile, denyFile: path.join(dir, 'denials.jsonl'), worktree: job.worktree, mode: job.mode, allowedCommands: runtime.allowedCommands, approvedMcp: runtime.approvedMcp,
    jobId: job.id.slice(5), context: runtime.context, observation: runtime.observation, observationFile: path.join(dir, 'observation.jsonl'),
    activityFile: path.join(dir, 'activity.json'), stopFile: path.join(dir, 'policy-stop.json'), traceInternalGateway: runtime.traceInternalGateway === true });
  const tools = [...(job.mode === 'review' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'safe_shell']),
    ...(await import('./approved-mcp.mjs')).approvedMcpToolNames(runtime.approvedMcp, job.mode)];
  const args = [...runtime.piArgs, '--mode', 'rpc', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline',
    '--tools', tools.join(','), '--session-dir', job.sessionDir, '-e', runtime.policyExtension];
  if (job.forkSessionFile) { args.push('--fork', job.forkSessionFile, '--session-id', randomUUID()); }
  else if (job.sessionFile) { await verifySession(job.sessionFile, true); args.push('--session', job.sessionFile); }
  else args.push('--session-id', randomUUID());
  child = spawn(runtime.piPath, args, { cwd: job.worktree, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_CODING_AGENT_DIR: runtime.agentDir, PI_MCP_POLICY: policyFile, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', DO_NOT_TRACK: '1' } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  job.piPid = child.pid;
  try {
    job.piIdentity = await processIdentity(child.pid);
  } catch (identityError) {
    // Pi is this worker's own direct child, spawned detached as its own
    // process-group leader (pgid === pid). If it already exited before this
    // process could read its /proc identity, verify — using this worker's
    // own boot id and pid namespace, which the child always inherits — that
    // no member of that exact process group is still alive before treating
    // Pi as stopped. A surviving descendant in the same group, or anything
    // this cannot verify, keeps today's fail-closed quarantine.
    const self = await processIdentity(process.pid).catch(() => null);
    const outcome = self
      ? await groupState({ pid: child.pid, pgid: child.pid, bootId: self.bootId, pidNamespace: self.pidNamespace, startTicks: '0' }).catch(() => ({ state: 'ambiguous', members: [] }))
      : { state: 'ambiguous', members: [] };
    if (outcome.state !== 'stopped') throw identityError;
    job.piExitedBeforeIdentity = true; job.piPid = null; await save();
    throw new Error('Pi exited during startup');
  }
  await save();
  rpc = new RpcClient(child.stdout, child.stdin);
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 2 * 1024 * 1024) { stderrOverflow = true; stderrChunks = []; } else if (!stderrOverflow) stderrChunks.push(chunk); });
  let fatal;
  child.on('error', error => { fatal = error; });
  rpc.on('event', event => {
    if (event.type === 'turn_start') {
      job.numTurns = (job.numTurns || 0) + 1;
      emitEvent({ type: 'turn_start', turn: job.numTurns });
      if (job.numTurns > job.maxTurns) stop('turn_limit').catch(() => {});
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      lastAssistantMessage = message;
      finalStopReason = ['stop', 'end_turn', 'error', 'aborted'].includes(message.stopReason) ? message.stopReason : 'other';
      if (message.stopReason === 'error' || message.stopReason === 'aborted') providerError = message.errorMessage || message.stopReason;
      else if (message.stopReason === 'stop' || message.stopReason === 'end_turn') providerError = '';
      const text = (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (text && !job.resultOmitted) {
        if (Buffer.byteLength(finalText) + Buffer.byteLength(text) > (runtime.artifacts?.maxFileBytes || 2 * 1024 * 1024)) { finalText = ''; job.resultOmitted = 'result_size_limit'; }
        else finalText += `${finalText ? '\n' : ''}${text}`;
        job.lastProgress = 'Assistant response received';
      }
      addUsage(message.usage);
      const budget = runtime.budgets || {};
      if ((message.content || []).length && Object.keys(budget).length && !stopping) {
        const measured = value => Number.isFinite(value) && value >= 0;
        const usage = message.usage || {};
        const observedTokens = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'total'].some(key => measured(usage[key]) && usage[key] > 0);
        const measuredTotal = measured(usage.totalTokens) || measured(usage.total) || measured(usage.input) && measured(usage.output);
        const dimensionsAvailable = (!budget.maxInputTokens || measured(usage.input)) && (!budget.maxOutputTokens || measured(usage.output)) && (!budget.maxTotalTokens || measuredTotal);
        const observedCost = measured(usage.cost?.total) && usage.cost.total > 0;
        if (!observedTokens || !dimensionsAvailable || budget.maxCostUsd && !observedCost) {
          job.budget = { status: 'unavailable', reason: !observedTokens || !dimensionsAvailable ? 'Model response lacked required measured token usage' : 'Model response lacked measured cost', inFlightOvershootPossible: true };
          stop('budget_unavailable').catch(() => {});
        }
      }
      emitEvent({ type: 'message_end', stopReason: finalStopReason, textBytes: Buffer.byteLength(text) });
    }
    if (event.type === 'agent_settled') { settled = true; piActive = false; }
    if (event.type === 'auto_retry_end' && event.success === true) providerError = '';
    if (event.type === 'error' || event.type === 'provider_error') {
      providerError = clean(event.message || event.error || 'Provider error');
      if (event.type === 'error') stop('failed').catch(() => {});
    }
  });
  const readinessDeadline = Date.now() + POLICY_READY_TIMEOUT_MS;
  let policyReady = false;
  while (Date.now() < readinessDeadline) {
    const ready = await fs.readFile(readyFile, 'utf8').then(text => { try { return JSON.parse(text); } catch { return null; } }, () => null);
    if (ready?.nonce === nonce && ready.pid === child.pid && Array.isArray(ready.tools)
      && ready.tools.length === tools.length && ready.tools.every(name => tools.includes(name))) { policyReady = true; break; }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Pi exited before policy readiness');
    if (stopping) throw new Error(`Stopped during startup: ${stopping}`);
    await delay(100);
  }
  if (!policyReady) throw new Error('Pi policy did not acknowledge verified readiness');
  const state = (await rpc.request('get_state')).data;
  job.sessionFile = await verifySession(state?.sessionFile);
  job.sessionId = state?.sessionId;
  await save();
  if (stopping) throw new Error(`Stopped during startup: ${stopping}`);
  const selected = await rpc.request('set_model', { provider: job.provider, modelId: job.model });
  const observedState = (await rpc.request('get_state')).data;
  const observed = observedState?.model || selected.data?.model || selected.data;
  if (observed?.provider !== job.provider || observed?.id !== job.model) throw new Error('Pi selected a different provider/model');
  job.effectiveModel = `${observed.provider}/${observed.id}`;
  if (job.images?.length && !modelSupportsImages(observed)) throw new Error('Selected model does not report image input support');
  job.modelInputImageSupported = modelSupportsImages(observed);
  if (runtime.budgets?.maxCostUsd) {
    const prices = Object.values(observed.cost || {}).filter(value => typeof value === 'number' && Number.isFinite(value));
    if (!prices.some(value => value > 0)) throw new Error('Cost budget unenforceable: selected model pricing unavailable or zero');
  }
  usageBaseline = await rpc.request('get_session_stats', {}, 1000).then(response => response.data, () => null);
  if (job.thinkingLevel) await rpc.request('set_thinking_level', { level: job.thinkingLevel });
  // Make Pi's own built-in retry (transient 429/5xx/timeout errors; see
  // pi-ai dist/utils/retry.js) explicit. provider-recovery.mjs only takes
  // over once that has already run out, or for anomalies Pi never retries
  // (an empty/truncated reply, or a malformed/parse-error response).
  await rpc.request('set_auto_retry', { enabled: true });
  if (stopping) throw new Error(`Stopped during startup: ${stopping}`);
  const initialPromptMessage = `${job.prompt}\n\nInspect worktree AGENTS.md with the confined read tool before modifying files. Work only in ${job.worktree}.`;
  job.providerRecovery = { attempts: 0, maxAttempts: providerRecoveryPolicy.maxAttempts, history: [] };
  let classification = null;
  for (let continuing = false; ; continuing = true) {
    settled = false;
    const settledPromise = rpc.waitFor('agent_settled', (job.timeoutSeconds + 10) * 1000);
    settledPromise.catch(() => {});
    piActive = true;
    lastPromptAt = now();
    const prompt = await rpc.request('prompt', continuing
      ? { message: CONTINUATION_PROMPT }
      : { message: initialPromptMessage, ...(job.images?.length ? { images: job.images } : {}) });
    if (prompt.data?.disposition !== 'started') throw new Error(`Unsupported prompt disposition: ${prompt.data?.disposition}`);
    let watcher;
    try {
      await Promise.race([settledPromise, new Promise(resolve => { watcher = setInterval(() => { if (stopping || child.exitCode !== null || child.signalCode !== null) resolve(); }, 100); })]);
    } finally { clearInterval(watcher); }
    piActive = false;
    if (fatal) throw fatal;
    if (stopping) break;
    if (!settled) throw new Error('Pi exited before agent_settled');
    classification = classifyFinalMessage(lastAssistantMessage || {});
    if (classification.healthy || !classification.recoverable) break;
    if (job.providerRecovery.attempts >= job.providerRecovery.maxAttempts) break;
    job.providerRecovery.attempts++;
    job.providerRecovery.history = [...job.providerRecovery.history, { attempt: job.providerRecovery.attempts, reason: classification.reason, at: now() }].slice(-10);
    await save();
    const delayMs = recoveryDelayMs(providerRecoveryPolicy, job.providerRecovery.attempts);
    await emitEvent({ type: 'provider_recovery', attempt: job.providerRecovery.attempts, reason: classification.reason, delayMs });
    const waitUntil = Date.now() + delayMs;
    recoveryWaiting = true;
    // Also wake up promptly if Pi itself exits during the backoff, instead
    // of always sleeping out the full (potentially long) delay before
    // noticing the next prompt() call has nothing left to talk to.
    while (!stopping && child.exitCode === null && child.signalCode === null && Date.now() < waitUntil) await delay(Math.min(100, waitUntil - Date.now()));
    recoveryWaiting = false;
    if (stopping) break;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Pi exited during provider recovery backoff');
  }
  if (!stopping && classification && !classification.healthy) {
    // Any unhealthy final message fails; a stop/end_turn reply that is neither
    // text nor recoverable (e.g. stray tool calls only) must not pass as success.
    if (!classification.recoverable) throw new Error(providerError || (['stop', 'end_turn'].includes(finalStopReason) ? 'Pi settled without an assistant result' : `Final stop reason: ${finalStopReason || 'missing'}`));
    else throw new Error(`Provider returned ${classification.reason} (recovery exhausted after ${job.providerRecovery.attempts} attempts)`);
  }
}

let finalizing;
async function finalize() {
  if (finalizing) return finalizing;
  finalizing = finalizeOnce();
  return finalizing;
}
async function captureSession() {
  if (!job.sessionFile) return;
  const file = await verifySession(job.sessionFile, true);
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error('Session checkpoint unsafe');
    if (before.size > 16 * 1024 * 1024) { job.sessionCheckpoint = { complete: false, reason: 'raw_session_too_large', size: before.size, codeResumeAvailable: true }; return; }
    bytes = Buffer.alloc(before.size); let cursor = 0;
    while (cursor < bytes.length) { const read = await handle.read(bytes, cursor, bytes.length - cursor, cursor); if (!read.bytesRead) throw new Error('Session changed during checkpoint'); cursor += read.bytesRead; }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error('Session changed during checkpoint');
  } finally { await handle.close(); }
  const targetDir = path.join(dir, 'private-session'); await fs.mkdir(targetDir, { mode: 0o700 });
  const target = path.join(targetDir, 'session.jsonl');
  await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  job.sessionCheckpoint = { complete: true, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}
async function observedSessionUsage() {
  if (!rpc || !usageBaseline) return;
  const latest = await rpc.request('get_session_stats', {}, 1000).then(response => response.data, () => null);
  if (!latest?.tokens || !usageBaseline.tokens) return;
  const delta = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    if (Number.isFinite(latest.tokens[key]) && latest.tokens[key] >= 0 && Number.isFinite(usageBaseline.tokens[key]) && usageBaseline.tokens[key] >= 0) delta[key] = Math.max(0, latest.tokens[key] - usageBaseline.tokens[key]);
  }
  const prior = job.usage || {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) if (delta[key] !== undefined) prior[key] = Math.max(prior[key] || 0, delta[key]);
  if (delta.total !== undefined) prior.totalTokens = Math.max(prior.totalTokens || 0, delta.total);
  if (Number.isFinite(latest.cost) && latest.cost >= 0 && Number.isFinite(usageBaseline.cost) && usageBaseline.cost >= 0 && latest.cost > usageBaseline.cost) prior.cost = { ...(prior.cost || {}), total: Math.max(prior.cost?.total || 0, latest.cost - usageBaseline.cost) };
  job.usage = prior;
  checkBudget();
}
async function finalizeOnce() {
  piActive = false;
  job.status = 'finalizing'; job.heartbeatAt = now(); await save();
  await observedSessionUsage();
  const outcome = job.piIdentity ? (await stopPromise ?? await stopOwnedGroup(job.piIdentity, 500).catch(() => ({ state: 'ambiguous' }))) : job.piPid ? { state: 'ambiguous' } : { state: 'stopped' };
  if (outcome.state !== 'stopped') {
    await drainWatchdog(); job.status = 'quarantined'; job.error = 'Pi process group could not be proved stopped';
    job.execution = { status: 'quarantined', stopReason: finalStopReason || null };
    job.verification = { status: 'skipped', reason: 'Pi writers not proved stopped', commands: [] };
    job.finishedAt = now(); job.heartbeatAt = now(); await emitEvent({ type: 'status', status: 'quarantined' }); await eventChain; await save(); rpc?.close(); return;
  }
  await consumeObservation().catch(error => { providerError = clean(error.message); if (!stopping) stopping = 'failed'; });
  let terminalStatus = stopping || providerError ? (stopping || 'failed') : 'completed';
  if (terminalStatus !== 'completed') job.error = providerError || `Stopped: ${stopping || 'failed'}`;
  job.execution = { status: terminalStatus === 'completed' ? 'passed' : terminalStatus, stopReason: finalStopReason || null };
  await refreshSecrets();
  if (providerError) providerError = clean(providerError);
  if (job.error) job.error = clean(job.error);
  job.exitCode = child?.exitCode ?? null;
  await captureSession().catch(error => { job.sessionCheckpoint = { complete: false, reason: clean(error.message), codeResumeAvailable: true }; });
  await inventory();
  try {
    const denialFile = path.join(dir, 'denials.jsonl');
    const denialStat = await fs.lstat(denialFile);
    if (!denialStat.isFile() || denialStat.nlink !== 1 || denialStat.size > 1024 * 1024) { job.permissionDenials = []; job.permissionDenialsTruncated = true; }
    else {
      const denialText = await fs.readFile(denialFile, 'utf8');
      job.permissionDenials = denialText.trim().split('\n').filter(Boolean).slice(-50).map(line => clean(JSON.parse(line)));
      job.permissionDenialsTruncated = denialText.split('\n').length > 51;
    }
  } catch { job.permissionDenials = []; }
  let resultText = job.resultOmitted ? '' : clean(finalText || providerError || `Stopped: ${stopping}`);
  if (Buffer.byteLength(resultText) > (runtime.artifacts?.maxFileBytes || 2 * 1024 * 1024) - 1024) { job.resultOmitted = 'public_output_limit'; resultText = ''; }
  await fs.writeFile(path.join(dir, 'result.txt'), resultText, { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ text: resultText, omittedReason: job.resultOmitted || null, execution: job.execution }), { mode: 0o600 });
  let stderrText = stderrOverflow ? '' : clean(Buffer.concat(stderrChunks).toString('utf8'));
  if (Buffer.byteLength(stderrText) > (runtime.artifacts?.maxFileBytes || 2 * 1024 * 1024)) { stderrOverflow = true; stderrText = ''; }
  await fs.writeFile(path.join(dir, 'stderr.log'), stderrText, { mode: 0o600 });
  job.stderrTruncated = stderrOverflow;
  if (terminalStatus === 'completed' && job.verificationIds?.length) {
    const preDir = path.join(dir, 'preverify'); await fs.mkdir(preDir, { mode: 0o700 });
    const before = await snapshotArtifacts({ jobDir: preDir, worktree: job.worktree, baseCommit: job.baseCommit, config: runtime.artifacts,
      sanitize: clean, env: process.env, materialBaseline: job.materialBaseline || [], inputMaterialsDigest: job.inputMaterialsDigest || null });
    job.verification = { status: before.checkpointComplete ? 'running' : 'unverified', commands: [], beforeDigest: before.inputSnapshotDigest };
    if (before.checkpointComplete) {
      for (const id of job.verificationIds) {
        const command = runtime.verification.commands.find(item => item.id === id);
        if (!command) { job.verification.status = 'unverified'; job.verification.reason = 'Administrator verification configuration changed'; break; }
        const result = await runVerifier(command, { cwd: job.worktree, env: process.env, sanitize: clean,
          onIdentity: async identity => { job.verifierIdentities = [...(job.verifierIdentities || []), identity]; await save(); },
          cancelled: () => !!stopping });
        job.verification.commands.push(result);
        if (result.status === 'quarantined') { terminalStatus = 'quarantined'; job.verification.status = 'quarantined'; break; }
        if (result.status !== 'passed') job.verification.status = 'failed';
      }
    } else job.verification.reason = 'Pre-verification source snapshot incomplete';
    if (terminalStatus !== 'quarantined') {
      const postDir = path.join(dir, 'postverify'); await fs.mkdir(postDir, { mode: 0o700 });
      const after = await snapshotArtifacts({ jobDir: postDir, worktree: job.worktree, baseCommit: job.baseCommit, config: runtime.artifacts,
        sanitize: clean, env: process.env, materialBaseline: job.materialBaseline || [], inputMaterialsDigest: job.inputMaterialsDigest || null });
      job.verification.afterDigest = after.inputSnapshotDigest;
      Object.assign(job.verification, evaluateVerification(before, after, job.verification.commands, job.verificationIds.length));
    }
  } else if (terminalStatus !== 'completed') job.verification = { status: 'skipped', reason: 'Execution did not complete', commands: [] };
  if (terminalStatus === 'quarantined') {
    await drainWatchdog(); job.status = 'quarantined'; job.error = 'Verifier process group could not be proved stopped';
    job.finishedAt = now(); job.heartbeatAt = now(); await emitEvent({ type: 'status', status: 'quarantined' }); await eventChain; await save(); rpc?.close(); return;
  }
  {
    try {
      const manifest = await snapshotArtifacts({ jobDir: dir, worktree: job.worktree, baseCommit: job.baseCommit, config: runtime.artifacts,
        sanitize: clean, env: process.env, materialBaseline: job.materialBaseline || [], inputMaterialsDigest: job.inputMaterialsDigest || null,
        reports: [{ name: 'result', file: 'result.json' }, { name: 'stderr', file: 'stderr.log' }] });
      job.verification = reconcileFinalSnapshot(job.verification, manifest);
      let verificationReport = JSON.stringify(job.verification);
      if (Buffer.byteLength(verificationReport) > (runtime.artifacts?.maxFileBytes || 2 * 1024 * 1024)) {
        job.verification.outputOmitted = 'report_size_limit';
        job.verification.commands = job.verification.commands.map(({ stdout, stderr, ...rest }) => ({ ...rest, stdout: '', stderr: '', truncated: true }));
        verificationReport = JSON.stringify(job.verification);
      }
      await fs.writeFile(path.join(dir, 'verification.json'), verificationReport, { mode: 0o600 });
      const finalManifest = await attachArtifactReport({ jobDir: dir, name: 'verification', file: 'verification.json', config: runtime.artifacts, sanitize: clean, env: process.env });
      job.artifacts = { manifestSha256: finalManifest.manifestSha256, inputSnapshotDigest: finalManifest.inputSnapshotDigest,
        checkpointComplete: finalManifest.checkpointComplete, exportComplete: finalManifest.exportComplete, applicable: finalManifest.applicable, omittedCount: finalManifest.omittedCount };
      if (terminalStatus === 'completed' && !manifest.checkpointComplete) { terminalStatus = 'failed'; job.error = 'Source checkpoint incomplete'; }
    } catch (error) { job.artifacts = { checkpointComplete: false, exportComplete: false, error: clean(error.message) }; job.verification = reconcileFinalSnapshot(job.verification, null); if (terminalStatus === 'completed') { terminalStatus = 'failed'; job.error = 'Artifact capture failed'; } }
  }
  await drainWatchdog();
  if (stopping && terminalStatus === 'completed') terminalStatus = stopping;
  job.status = terminalStatus;
  job.finishedAt = now(); job.heartbeatAt = now(); await emitEvent({ type: 'status', status: job.status, verification: job.verification.status }); await eventChain; await save();
  rpc?.close();
}
let pollingControls = false;
async function pumpControls() {
  // Normally skipped once settled (nothing left running to steer), but a
  // provider-recovery backoff also leaves `settled` true from the previous
  // run between attempts; allow it specifically then, since Pi's own
  // session.steer()/agent.steer() unconditionally queue a steering message
  // regardless of whether a turn is active, and the next prompt() call's
  // initial steering poll drains that queue into the continuation's first
  // turn (see docs/provider-resilience.md).
  if (pollingControls || !rpc || stopping || (settled && !recoveryWaiting) || job.status !== 'running') return;
  pollingControls = true;
  const controls = path.join(dir, 'controls');
  try {
    const names = await fs.readdir(controls).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of names.filter(value => /^pending-[0-9a-f-]{36}\.json$/.test(value)).sort().slice(0, 8)) {
      if (stopping || (settled && !recoveryWaiting) || job.status !== 'running') break;
      const processing = name.replace('pending-', 'processing-');
      try { await fs.rename(path.join(controls, name), path.join(controls, processing)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const control = JSON.parse(await fs.readFile(path.join(controls, processing), 'utf8'));
      const ack = path.join(controls, `ack-${control.id}.json`);
      await atomicJson(ack, { id: control.id, status: 'received' });
      await emitEvent({ type: 'steer', controlId: control.id, status: 'received' });
      let delivered = false;
      try {
        if (control.images?.length && !job.modelInputImageSupported) throw new Error('Selected model does not support images');
        const images = normalizeImages(control.images || []);
        const authoritativeInstructions = extendAuthoritativeInstructions(job, control.message);
        delivered = true;
        const response = await rpc.request('steer', { message: control.message, ...(images.length ? { images } : {}) }, 3000);
        const disposition = response.data?.disposition;
        if (!['queued', 'handled'].includes(disposition)) throw new Error('Unsupported steer disposition');
        const status = disposition === 'queued' ? 'queued_by_pi' : 'handled_by_pi';
        job.authoritativeInstructions = authoritativeInstructions;
        job.authoritativeSteerIds = [...(job.authoritativeSteerIds || []), control.id];
        if (images.length) job.imageContextRequired = true;
        await save();
        await atomicJson(ack, { id: control.id, status, disposition });
        await fs.rm(path.join(controls, processing), { force: true });
        await emitEvent({ type: 'steer', controlId: control.id, status });
      } catch {
        if (!delivered) await fs.rm(path.join(controls, processing), { force: true });
        await atomicJson(ack, { id: control.id, status: 'unknown' }); await emitEvent({ type: 'steer', controlId: control.id, status: 'unknown' });
      }
      const receipts = (await fs.readdir(controls)).filter(value => /^ack-[0-9a-f-]{36}\.json$/.test(value)).sort();
      for (const stale of receipts.slice(0, Math.max(0, receipts.length - 100))) await fs.rm(path.join(controls, stale), { force: true });
    }
  } finally { pollingControls = false; }
}
async function readPrivateJson(name, limit = 4096) {
  const handle = await fs.open(path.join(dir, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Private policy metadata invalid');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
async function consumeObservation() {
  const observationFile = path.join(dir, 'observation.jsonl');
  const handle = await fs.open(observationFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (handle) {
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > (runtime.observation?.maxBytes || 65536)) throw new Error('Observation metadata invalid');
      const content = await handle.readFile('utf8');
      const records = content.split('\n').slice(0, -1).filter(Boolean);
      for (const line of records) {
        const item = JSON.parse(line);
        if (item.version !== 1 || typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || typeof item.kind !== 'string' || !/^[a-z_]{1,40}$/.test(item.kind) || !/^\d{4}-\d\d-\d\dT/.test(item.at || '')) throw new Error('Observation record invalid');
        if (seenObservationIds.has(item.id)) continue;
        seenObservationIds.add(item.id);
        if (seenObservationIds.size > 2048) seenObservationIds.delete(seenObservationIds.values().next().value);
        const safe = { type: 'observation', kind: item.kind, at: item.at };
        for (const field of ['jobId', 'requestId', 'providerCallId', 'toolId']) if (typeof item[field] === 'string' && /^[0-9a-f-]{36}$/.test(item[field])) safe[field] = item[field];
        if (typeof item.toolName === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(item.toolName)) safe.toolName = item.toolName;
        for (const field of ['durationMs', 'isError', 'droppedMessages']) if (typeof item[field] === 'number' && Number.isFinite(item[field]) || typeof item[field] === 'boolean') safe[field] = item[field];
        for (const field of ['category', 'outcome', 'retryReason']) if (typeof item[field] === 'string' && /^[a-z_]{1,40}$/.test(item[field])) safe[field] = item[field];
        await emitEvent(safe);
      }
    } finally { await handle.close(); }
  }
  const activity = await readPrivateJson('activity.json');
  if (activity) {
    if (activity.version !== 1 || activity.lastEventAt !== null && activity.lastEventAt !== undefined && !/^\d{4}-\d\d-\d\dT/.test(activity.lastEventAt) || activity.lastProgressAt !== null && activity.lastProgressAt !== undefined && !/^\d{4}-\d\d-\d\dT/.test(activity.lastProgressAt)) throw new Error('Policy activity invalid');
    job.lastProgressAt = activity.lastProgressAt || job.lastProgressAt;
    job.observation = { lastEventAt: activity.lastEventAt, lastProgressAt: activity.lastProgressAt || null,
      consecutiveToolFailures: Number.isSafeInteger(activity.consecutiveToolFailures) ? activity.consecutiveToolFailures : 0,
      lastKind: /^[a-z_]{1,40}$/.test(activity.lastKind || '') ? activity.lastKind : null };
  }
  const policyStop = await readPrivateJson('policy-stop.json');
  if (policyStop) {
    const map = { idle: 'idle_timeout', repeated_tool_failure: 'tool_failure_limit', context_limit: 'context_limit' };
    if (policyStop.version !== 1 || !map[policyStop.reason]) throw new Error('Policy stop invalid');
    await stop(map[policyStop.reason]);
  }
  if (piActive && !stopping && runtime.observation?.idleTimeoutMs > 0) {
    // job.lastProgressAt/job.startedAt alone predate a provider-recovery
    // backoff: if that backoff is itself longer than idleTimeoutMs, the
    // instant piActive becomes true again for the continuation prompt the
    // elapsed time already exceeds the idle budget, stopping the job as
    // idle_timeout before Pi has had any chance to answer. lastPromptAt is
    // refreshed every time a prompt (initial or continuation) is sent, so
    // taking the max here resets the idle clock to that send time.
    const idleBaseline = Math.max(Date.parse(job.lastProgressAt || job.startedAt), lastPromptAt ? Date.parse(lastPromptAt) : -Infinity);
    if (Date.now() - idleBaseline > runtime.observation.idleTimeoutMs) await stop('idle_timeout');
  }
  if (piActive && !stopping && runtime.observation?.consecutiveFailureLimit > 0 && job.observation?.consecutiveToolFailures >= runtime.observation.consecutiveFailureLimit) await stop('tool_failure_limit');
}
let watchdogClosing = false, watchdogActive = null;
const watchdog = setInterval(() => {
  if (watchdogClosing || watchdogActive) return;
  watchdogActive = (async () => {
  try {
    job.heartbeatAt = now(); await save();
    await pumpControls();
    await consumeObservation();
    if (await fs.stat(path.join(dir, 'cancel')).then(() => true, () => false)) await stop('cancelled');
    if (job.startedAt && Date.now() - Date.parse(job.startedAt) >= job.timeoutSeconds * 1000) await stop('timed_out');
  } catch (error) { providerError = clean(error.message); await stop('failed').catch(() => {}); }
  })().finally(() => { watchdogActive = null; });
}, 500);
async function drainWatchdog() { watchdogClosing = true; clearInterval(watchdog); await watchdogActive; }
let fatalHandling = false;
async function fatal(error) {
  if (fatalHandling) return;
  fatalHandling = true;
  providerError = clean(error?.message || String(error));
  if (!stopping) stopping = 'failed';
  try {
    await refreshSecrets();
    await writePrivate('worker-error.log', error?.stack || String(error));
    await finalize();
  } catch (cleanupError) {
    job.status = 'quarantined'; job.error = clean(`Worker cleanup could not be verified: ${cleanupError.message}`);
    job.finishedAt = now(); await save().catch(() => {});
  }
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
try { await run(); }
catch (error) { providerError = clean(error.message); if (!stopping) stopping = 'failed'; }
finally { await finalize(); }
