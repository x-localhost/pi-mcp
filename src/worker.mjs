import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RpcClient } from './rpc.mjs';
import { atomicJson, git } from './manager.mjs';
import { sanitize } from './sanitize.mjs';
import { scanTemplate, validateProviderHeaders, collectHeaderSecrets } from './headers.mjs';

process.umask(0o077);
const exec = promisify(execFile);
const dir = process.argv[2];
const jobFile = path.join(dir, 'job.json');
let job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
const runtime = JSON.parse(await fs.readFile(path.join(dir, 'runtime.json'), 'utf8'));
let saveChain = Promise.resolve();
const save = () => { const snapshot = structuredClone(job); saveChain = saveChain.then(() => atomicJson(jobFile, snapshot)); return saveChain; };
const now = () => new Date().toISOString();
const sessionRoot = await fs.realpath(job.sessionDir);
let child, rpc, stopping, finalText = '', settled = false, finalStopReason, providerError = '', stderr = '', logBytes = 0;
const stopTimers = [];
const secretValues = [];
// A value reached through a "headers" map is treated as secret regardless of
// length (even 1-5 characters), since arbitrary custom header names cannot be
// recognized by the generic token/key/secret/... name pattern below. Uses the
// same $$ / $! / $NAME / ${NAME} grammar as src/headers.mjs so an escaped
// literal is never mistaken for an unresolved (and then leaked) reference.
const collectSecrets = (value, key = '', sensitive = false, headerSourced = false) => {
  if (typeof value === 'string' && (sensitive || headerSourced || /(?:token|key|secret|password|access|refresh|auth|credential)/i.test(key))) {
    let resolved = '';
    for (const part of scanTemplate(value)) {
      if (part.type === 'literal') { resolved += part.text; continue; }
      const replacement = process.env[part.name];
      if (typeof replacement !== 'string') continue;
      if (headerSourced || replacement.length >= 6) secretValues.push(replacement);
      resolved += replacement;
    }
    if (resolved && (headerSourced || resolved.length >= 6)) secretValues.push(resolved);
  } else if (value && typeof value === 'object') {
    const childHeaderSourced = headerSourced || /headers?/i.test(key);
    for (const [childKey, entry] of Object.entries(value)) collectSecrets(entry, childKey, sensitive || /headers?/i.test(key), childHeaderSourced);
  }
};
const refreshSecrets = async () => {
  const configs = {};
  for (const name of ['auth.json', 'models.json']) {
    try { configs[name] = JSON.parse(await fs.readFile(path.join(runtime.agentDir, name), 'utf8')); collectSecrets(configs[name]); } catch {}
  }
  secretValues.push(...collectHeaderSecrets(configs['models.json'], configs['auth.json'], process.env));
};
await refreshSecrets();
const clean = value => sanitize(value, process.env, secretValues);
const addUsage = usage => {
  if (!usage || typeof usage !== 'object') return;
  const previous = job.usage || {};
  const result = { ...previous };
  for (const [key, value] of Object.entries(usage)) {
    if (key === 'cost' && value && typeof value === 'object') {
      result.cost = { ...(result.cost || {}) };
      for (const [costKey, amount] of Object.entries(value)) if (typeof amount === 'number') result.cost[costKey] = (result.cost[costKey] || 0) + amount;
    } else if (typeof value === 'number') result[key] = (result[key] || 0) + value;
  }
  job.usage = result;
};
const writePrivate = (name, text) => fs.writeFile(path.join(dir, name), clean(text), { mode: 0o600 });
function groupSignal(signal) { if (child?.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } } }
const groupRunning = async () => {
  if (!child?.pid) return false;
  try {
    const { stdout } = await exec('ps', ['-A', '-o', 'pgid=,stat='], { timeout: 3000 });
    return stdout.split('\n').some(line => {
      const [pgid, state] = line.trim().split(/\s+/);
      return Number(pgid) === child.pid && state && !state.startsWith('Z');
    });
  } catch {
    try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop(reason) {
  if (stopping) return;
  stopping = reason; job.lastProgress = `Stopping: ${reason}`; await save();
  if (rpc && child?.exitCode === null) {
    await rpc.request('clear_queue', {}, 1000).catch(() => {});
    rpc.request('abort', {}, 2000).catch(() => {});
  }
  stopTimers.push(setTimeout(() => groupSignal('SIGTERM'), 1500));
  stopTimers.push(setTimeout(() => groupSignal('SIGKILL'), 4000));
  for (const timer of stopTimers) timer.unref();
}
async function inventory() {
  try {
    const [diffStat, tracked, untracked, patch] = await Promise.all([
      git(job.worktree, ['diff', '--stat', job.baseCommit]),
      git(job.worktree, ['diff', '--name-only', '-z', job.baseCommit], true),
      git(job.worktree, ['ls-files', '--others', '--exclude-standard', '-z'], true),
      git(job.worktree, ['diff', '--binary', job.baseCommit], true)
    ]);
    job.diffStat = clean(diffStat).slice(0, 8000);
    job.changedFiles = [...tracked.split('\0').filter(Boolean).map(file => ({ path: clean(file), kind: 'tracked' })),
      ...untracked.split('\0').filter(Boolean).map(file => ({ path: clean(file), kind: 'untracked' }))].slice(0, 200);
    await writePrivate('changes.patch', patch.slice(0, 1024 * 1024));
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
  job.workerPid = process.pid; job.status = 'running'; job.startedAt = now(); job.heartbeatAt = now(); await save();
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
  await atomicJson(policyFile, { nonce, readyFile, denyFile: path.join(dir, 'denials.jsonl'), worktree: job.worktree, mode: job.mode, allowedCommands: runtime.allowedCommands });
  const tools = job.mode === 'review' ? 'read,grep,find,ls' : 'read,grep,find,ls,write,edit,safe_shell';
  const args = [...runtime.piArgs, '--mode', 'rpc', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline',
    '--tools', tools, '--session-dir', job.sessionDir, '-e', runtime.policyExtension];
  if (job.sessionFile) { await verifySession(job.sessionFile, true); args.push('--session', job.sessionFile); }
  else args.push('--session-id', randomUUID());
  child = spawn(runtime.piPath, args, { cwd: job.worktree, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_CODING_AGENT_DIR: runtime.agentDir, PI_MCP_POLICY: policyFile, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', DO_NOT_TRACK: '1' } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  job.piPid = child.pid; await save();
  rpc = new RpcClient(child.stdout, child.stdin);
  child.stderr.on('data', chunk => { logBytes += chunk.length; if (logBytes < 2 * 1024 * 1024) stderr = (stderr + chunk.toString('utf8')).slice(-32000); });
  let fatal;
  child.on('error', error => { fatal = error; });
  rpc.on('event', event => {
    if (event.type === 'turn_start') {
      job.numTurns = (job.numTurns || 0) + 1;
      if (job.numTurns > job.maxTurns) stop('turn_limit').catch(() => {});
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      finalStopReason = message.stopReason;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') providerError = message.errorMessage || message.stopReason;
      else if (message.stopReason === 'stop' || message.stopReason === 'end_turn') providerError = '';
      const text = (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (text) { finalText = (finalText + '\n' + text).slice(-50000); job.lastProgress = 'Assistant response received'; }
      addUsage(message.usage);
    }
    if (event.type === 'agent_settled') settled = true;
    if (event.type === 'auto_retry_end' && event.success === true) providerError = '';
    if (event.type === 'error' || event.type === 'provider_error') {
      providerError = clean(event.message || event.error || 'Provider error');
      if (event.type === 'error') stop('failed').catch(() => {});
    }
  });
  const readinessDeadline = Date.now() + 15000;
  let policyReady = false;
  while (Date.now() < readinessDeadline) {
    const ready = await fs.readFile(readyFile, 'utf8').then(text => { try { return JSON.parse(text); } catch { return null; } }, () => null);
    if (ready?.nonce === nonce && ready.pid === child.pid && Array.isArray(ready.tools)
      && ready.tools.length === tools.split(',').length && ready.tools.every(name => tools.split(',').includes(name))) { policyReady = true; break; }
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
  if (job.thinkingLevel) await rpc.request('set_thinking_level', { level: job.thinkingLevel });
  if (stopping) throw new Error(`Stopped during startup: ${stopping}`);
  const settledPromise = rpc.waitFor('agent_settled', (job.timeoutSeconds + 10) * 1000);
  settledPromise.catch(() => {});
  const prompt = await rpc.request('prompt', { message: `${job.prompt}\n\nInspect worktree AGENTS.md with the confined read tool before modifying files. Work only in ${job.worktree}.` });
  if (prompt.data?.disposition !== 'started') throw new Error(`Unsupported prompt disposition: ${prompt.data?.disposition}`);
  let watcher;
  try {
    await Promise.race([settledPromise, new Promise(resolve => { watcher = setInterval(() => { if (stopping || child.exitCode !== null || child.signalCode !== null) resolve(); }, 100); })]);
  } finally { clearInterval(watcher); }
  if (fatal) throw fatal;
  if (!settled && !stopping) throw new Error('Pi exited before agent_settled');
  if (!stopping && (providerError || !['stop', 'end_turn'].includes(finalStopReason))) throw new Error(providerError || `Final stop reason: ${finalStopReason || 'missing'}`);
  if (!stopping && !finalText.trim()) throw new Error('Pi settled without an assistant result');
}

let finalizing;
async function finalize() {
  if (finalizing) return finalizing;
  finalizing = finalizeOnce();
  return finalizing;
}
async function finalizeOnce() {
  clearInterval(watchdog);
  for (const timer of stopTimers) clearTimeout(timer);
  if (child?.pid) {
    groupSignal('SIGTERM'); await delay(500);
    if (await groupRunning()) { groupSignal('SIGKILL'); await delay(500); }
    for (let attempt = 0; attempt < 10 && await groupRunning(); attempt++) await delay(200);
  }
  if (await groupRunning()) { job.status = 'quarantined'; job.error = 'Pi process group could not be verified stopped'; }
  else {
    job.status = stopping || providerError ? (stopping || 'failed') : 'completed';
    if (job.status === 'failed') job.error = providerError || 'Worker failed';
    else if (stopping) job.error = providerError || `Stopped: ${stopping}`;
  }
  await refreshSecrets();
  if (providerError) providerError = clean(providerError);
  if (job.error) job.error = clean(job.error);
  job.exitCode = child?.exitCode ?? null; job.finishedAt = now(); job.heartbeatAt = now();
  if (job.status === 'completed' && job.sessionFile) await verifySession(job.sessionFile, true).catch(error => { job.status = 'failed'; job.error = clean(error.message); });
  await inventory();
  try {
    const denialText = await fs.readFile(path.join(dir, 'denials.jsonl'), 'utf8');
    job.permissionDenials = denialText.trim().split('\n').filter(Boolean).slice(-50).map(line => clean(JSON.parse(line)));
  } catch { job.permissionDenials = []; }
  await writePrivate('result.txt', finalText || providerError || `Stopped: ${stopping}`);
  await writePrivate('stderr.log', stderr);
  await save();
  for (const timer of stopTimers) clearTimeout(timer);
  rpc?.close();
}
const watchdog = setInterval(async () => {
  try {
    job.heartbeatAt = now(); await save();
    if (await fs.stat(path.join(dir, 'cancel')).then(() => true, () => false)) await stop('cancelled');
    if (job.startedAt && Date.now() - Date.parse(job.startedAt) >= job.timeoutSeconds * 1000) await stop('timed_out');
  } catch (error) { providerError = clean(error.message); await stop('failed').catch(() => {}); }
}, 500);
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
