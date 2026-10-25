import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitize } from './sanitize.mjs';
import { validateProviderHeaders, collectHeaderSecrets } from './headers.mjs';
import { withOwnershipLock } from './ownership.mjs';
import { appendJobEvent, readJobEvents } from './events.mjs';
import { applyOfflineMaterials } from './offline-materials.mjs';
import { identityState, groupState, stopOwnedGroup, processIdentity } from './ownership.mjs';
import { scanState } from './storage.mjs';
import { normalizeImages } from './images.mjs';
import { listArtifacts, readArtifact, restoreCheckpoint, snapshotArtifacts } from './artifacts.mjs';
import { normalizeAcceptance, inheritAcceptance, evaluateAcceptance, contractDigest } from './acceptance.mjs';
import { buildHandoff, extendAuthoritativeInstructions, shouldAutoRollover } from './session-transition.mjs';
import { readWorkflowReferences } from './workflow.mjs';

const exec = promisify(execFile);
const codeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const active = new Set(['starting', 'running', 'finalizing', 'quarantined']);
// Mirrors src/config.mjs normalizeProviderRecovery()'s defaults, for raw
// config objects (tests, or any caller bypassing loadConfig) that omit the
// optional providerRecovery section entirely.
const DEFAULT_PROVIDER_RECOVERY = Object.freeze({ maxAttempts: 2, baseDelayMs: 5000, maxDelayMs: 60000 });
const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'turn_limit', 'interrupted', 'queue_expired', 'budget_limit', 'budget_unavailable', 'context_limit', 'idle_timeout', 'tool_failure_limit']);
// Single source of truth for which job statuses are terminal, reused by
// internal-agent/export-artifacts.mjs so its own export gate cannot drift
// out of sync with this list (a stale inline copy there once omitted
// context_limit, idle_timeout and tool_failure_limit).
export const TERMINAL_STATUSES = terminal;
const idPattern = /^task-[0-9a-f-]{36}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const admissionHash = (input, repository, parentId = null, forkFromId = null, codeOnly = false, reviewSourceId = null, rolloverFromId = null) =>
  sha(stable({ ...input, repository, parentId, forkFromId, codeOnly, reviewSourceId, rolloverFromId }));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
// scanState's own "State scan bound exceeded" is intentionally fail-closed and
// stays as-is at its own call sites (test/completion-runtime.test.mjs asserts
// /scan bound/i directly on scanState). Admission, submission and health only
// rewrite that specific message into one an operator can act on.
const actionableScanError = error => /scan bound/i.test(error.message)
  ? new Error('State scan bound exceeded; run pi_cleanup or raise retention.maxScanEntries')
  : error;
export function fixedGatewayTraceEligible(validated, config, job, models) {
  return validated === true && config.configFile === '/etc/pi-internal/config.json' && config.provider === 'corporate' &&
    job.provider === 'corporate' && job.model === config.model && config.modelsFile === '/etc/pi-internal/models.json' &&
    models?.providers?.corporate?.baseUrl === 'http://127.0.0.1:18080/v1' && models.providers.corporate.api === 'openai-completions' &&
    models.providers.corporate.models?.length === 1 && models.providers.corporate.models[0].id === job.model;
}

export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function git(repo, args, raw = false, env = process.env) {
  const { stdout } = await exec('git', ['-C', repo, ...args], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env });
  return raw ? stdout : stdout.trimEnd();
}
function assertId(id) { if (!idPattern.test(id)) throw new Error('Invalid job_id'); }
function required(value, name, max) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`); }
function rejectCommands(value, keyName = '') {
  if (Array.isArray(value)) { for (const child of value) rejectCommands(child, keyName); return; }
  if (typeof value === 'string' && /^!/.test(value.trim()) && /(?:apiKey|headers?|credential|token|secret|^key$|access|refresh)/i.test(keyName)) throw new Error('Command-bearing credential value is unsupported');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:apiKeyCommand|command|exec|shell|credentialCommand)$/i.test(key)) throw new Error('Command-bearing models configuration is unsupported');
    rejectCommands(child, /headers?/i.test(keyName) ? keyName : key);
  }
}

export class Manager {
  constructor(config, childEnv = {}, options = {}) {
    this.config = config; this.childEnv = childEnv; this.spawnWorker = options.spawnWorker !== false;
    this.jobsDir = path.join(config.stateDir, 'jobs'); this.worktreesDir = path.join(config.stateDir, 'worktrees');
    this.agentDir = path.join(config.stateDir, 'agent');
  }
  async init() {
    await fs.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    this.config.stateDir = await fs.realpath(this.config.stateDir);
    this.jobsDir = path.join(this.config.stateDir, 'jobs'); this.worktreesDir = path.join(this.config.stateDir, 'worktrees');
    this.agentDir = path.join(this.config.stateDir, 'agent');
    for (const dir of [this.config.stateDir, this.jobsDir, this.worktreesDir, this.agentDir]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700);
    }
    return this;
  }
  jobDir(id) { assertId(id); return path.join(this.jobsDir, id); }
  async read(id) { return JSON.parse(await fs.readFile(path.join(this.jobDir(id), 'job.json'), 'utf8')); }
  async lock(run) {
    return withOwnershipLock(path.join(this.config.stateDir, 'submit.lock'), run);
  }
  async appendEvent(id, event) {
    const secrets = await this.headerSecretValues();
    const safe = Object.fromEntries(Object.entries(event).map(([key, value]) => [key,
      key === 'type' && ['progress', 'status', 'turn_start', 'message_end', 'steer'].includes(value)
        || key === 'status' && ['queued', 'starting', 'running', 'finalizing', 'completed', 'failed', 'cancelled', 'received', 'queued_by_pi', 'handled_by_pi', 'unknown'].includes(value)
        || key === 'controlId' && /^[0-9a-f-]{36}$/.test(value) ? value : sanitize(value, this.childEnv, secrets)]));
    return appendJobEvent(this.jobDir(id), safe);
  }
  async events(id, options = {}) { return this.lock(() => readJobEvents(this.jobDir(id), options)); }
  async ensureDispatcher() {
    if (!this.spawnWorker || !this.config.queue) return;
    const configFile = this.config.configFile || process.env.PI_MCP_CONFIG;
    if (!configFile) throw new Error('Queued dispatcher requires a configuration file');
    const dispatcherEnv = { ...this.childEnv, PI_MCP_CONFIG: configFile };
    if (process.env.PI_INTERNAL_GATEWAY_VALIDATED === '1' && configFile === '/etc/pi-internal/config.json') dispatcherEnv.PI_INTERNAL_GATEWAY_VALIDATED = '1';
    // The dispatcher loads configuration again. Preserve only the already
    // validated values needed to resolve named proxy selectors on that pass.
    for (const [field, target] of [['httpProxyEnv', 'HTTP_PROXY'], ['httpsProxyEnv', 'HTTPS_PROXY'], ['allProxyEnv', 'ALL_PROXY'], ['noProxyEnv', 'NO_PROXY']]) {
      const sourceName = this.config.network?.[field];
      if (sourceName && this.childEnv[target] !== undefined) dispatcherEnv[sourceName] = this.childEnv[target];
    }
    const child = spawn(process.execPath, [path.join(codeRoot, 'src', 'dispatcher.mjs'), configFile], { cwd: codeRoot, detached: true, stdio: 'ignore', env: dispatcherEnv });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
  frozenPolicy(job) {
    const materialIds = job.materials || [];
    const materials = materialIds.map(id => this.config.offlineMaterials?.materials?.find(item => item.id === id));
    const verifierIds = job.verificationIds || [];
    const verification = verifierIds.map(id => this.config.verification?.commands?.find(item => item.id === id));
    return { allowedCommands: this.config.allowedCommands || [], approvedMcp: this.config.approvedMcp || { servers: [] }, materials, verification,
      artifacts: this.config.artifacts || {}, budgets: this.config.budgets || {}, context: this.config.context || {}, observation: this.config.observation || {},
      providerRecovery: this.config.providerRecovery || DEFAULT_PROVIDER_RECOVERY, mode: job.mode, provider: job.provider, model: job.model,
      allowedRoots: this.config.allowedRoots, piPath: this.config.piPath, piArgs: this.config.piArgs || [], envAllowlist: this.config.envAllowlist || [],
      network: this.config.network || {}, agentDir: this.config.agentDir || null, modelsFile: this.config.modelsFile || null, authFile: this.config.authFile || null };
  }
  async launchWorker(job) {
    const dir = this.jobDir(job.id);
    await this.seedAgent();
    const models = await this.loadAgentJson('models.json', this.config.modelsFile);
    const traceInternalGateway = fixedGatewayTraceEligible(process.env.PI_INTERNAL_GATEWAY_VALIDATED === '1', this.config, job, models);
    await atomicJson(path.join(dir, 'runtime.json'), { piPath: this.config.piPath, piArgs: this.config.piArgs || [],
      agentDir: this.agentDir, allowedCommands: this.config.allowedCommands || [], policyExtension: path.join(codeRoot, 'src', 'policy-extension.mjs'),
      ownedModelsRequired: !!await fs.stat(path.join(this.agentDir, 'models.json')).then(() => true, () => false),
      ownedAuthRequired: !!await fs.stat(path.join(this.agentDir, 'auth.json')).then(() => true, () => false),
      configFile: this.config.configFile || process.env.PI_MCP_CONFIG || null,
      verification: this.config.verification || { commands: [] }, artifacts: this.config.artifacts || {}, budgets: this.config.budgets || {}, approvedMcp: this.config.approvedMcp || { servers: [] },
      context: this.config.context || {}, observation: this.config.observation || {},
      providerRecovery: this.config.providerRecovery || DEFAULT_PROVIDER_RECOVERY,
      traceInternalGateway });
    if (this.spawnWorker) {
      const child = spawn(process.execPath, [path.join(codeRoot, 'src', 'worker.mjs'), dir], {
        cwd: codeRoot, detached: true, stdio: 'ignore', env: { ...this.childEnv, PI_CODING_AGENT_DIR: this.agentDir }
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref(); await fs.writeFile(path.join(dir, 'worker.pid'), String(child.pid), { mode: 0o600 });
      // Record the worker's process identity immediately in a separate file.
      // If the worker dies before its own first save of job.workerIdentity,
      // recoverJob() can still prove ownership instead of reporting 'unknown'
      // forever. A separate file avoids rewriting job.json from this stale
      // copy while the worker may already be saving its own state.
      const earlyIdentity = await processIdentity(child.pid).catch(() => null);
      if (earlyIdentity) await atomicJson(path.join(dir, 'worker-identity.json'), earlyIdentity);
    }
  }
  async dispatchOnce() {
    return this.lock(async () => {
      const jobs = await this.all(); const queued = jobs.filter(item => item.status === 'queued').sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0));
      let changed = false;
      for (const job of queued) if (Date.now() >= Date.parse(job.queueExpiresAt)) {
        job.status = 'queue_expired'; job.finishedAt = now(); job.error = 'Queue wait expired before admission';
        await atomicJson(path.join(this.jobDir(job.id), 'job.json'), job); changed = true;
      }
      let capacity = this.config.maxConcurrent - jobs.filter(item => active.has(item.status)).length;
      for (const job of queued.filter(item => item.status === 'queued')) {
        if (capacity <= 0) break;
        if (jobs.some(item => active.has(item.status) && item.worktree === job.worktree)) break;
        if (sha(stable(this.frozenPolicy(job))) !== job.policyDigest) {
          job.status = 'failed'; job.error = 'Queued administrator policy changed before admission'; job.finishedAt = now();
          await atomicJson(path.join(this.jobDir(job.id), 'job.json'), job); changed = true; continue;
        }
        try {
          if (job.parentJobId && (await this.sessionSealed(job.sessionDir) || jobs.some(item => item.rolloverFromId && jobs.find(source => source.id === item.rolloverFromId)?.sessionDir === job.sessionDir))) throw new Error('Source session sealed by rollover');
          if (await this.sourceConfigDigest() !== job.sourceConfigDigest) throw new Error('Queued model configuration changed before admission');
          if (await this.repository(job.repository) !== job.repository) throw new Error('Queued repository no longer allowed');
          await this.validateHeaders(job.provider, job.model);
          if (this.config.retention) {
            let usage;
            try { usage = await scanState(this.config.stateDir, this.config.retention); }
            catch (error) { throw actionableScanError(error); }
            if (!usage.withinLimit) throw new Error('State soft storage admission limit reached');
          }
          if (!job.parentJobId) await git(job.repository, ['worktree', 'add', '-b', job.branch, job.worktree, job.baseCommit], false, this.childEnv);
          await fs.mkdir(job.sessionDir, { recursive: true, mode: 0o700 });
          if (job.parentJobId) {
            const parent = await this.read(job.parentJobId);
            job.materialBaseline = parent.materialBaseline || []; job.inputMaterialsDigest = parent.inputMaterialsDigest || null; job.materialsIdentity = parent.materialsIdentity || [];
            job.inputSnapshotDigest = parent.artifacts?.inputSnapshotDigest || null;
          } else if (job.materials?.length) {
            const applied = await applyOfflineMaterials({ worktree: job.worktree, baseCommit: job.baseCommit, selections: job.materials, config: this.config.offlineMaterials, env: this.childEnv });
            job.materialBaseline = applied.materialBaseline; job.inputMaterialsDigest = applied.inputMaterialsDigest; job.materialsIdentity = applied.materials;
          }
          if (job.forkJobId) {
            const sourceDir = this.jobDir(job.forkJobId);
            const restored = await restoreCheckpoint({ jobDir: sourceDir, worktree: job.worktree, env: this.childEnv });
            job.inputSnapshotDigest = restored.inputSnapshotDigest;
            if (!job.codeOnly) {
            const source = await this.read(job.forkJobId);
            if (!source.sessionCheckpoint?.complete) throw new Error('Source session checkpoint incomplete');
            const sourceFile = path.join(sourceDir, 'private-session', 'session.jsonl');
            const handle = await fs.open(sourceFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            let bytes;
            try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== source.sessionCheckpoint.size || stat.size > 16 * 1024 * 1024) throw new Error('Source session checkpoint changed');
              bytes = Buffer.alloc(stat.size); let offset = 0; while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error('Source session changed'); offset += read.bytesRead; }
            } finally { await handle.close(); }
            if (sha(bytes) !== source.sessionCheckpoint.sha256) throw new Error('Source session checkpoint digest mismatch');
            const forkDir = path.join(this.jobDir(job.id), 'fork-input'); await fs.mkdir(forkDir, { mode: 0o700 });
            job.forkSessionFile = path.join(forkDir, 'session.jsonl'); await fs.writeFile(job.forkSessionFile, bytes, { flag: 'wx', mode: 0o600 });
            }
          }
          job.status = 'starting'; job.admittedAt = now(); await atomicJson(path.join(this.jobDir(job.id), 'job.json'), job);
          await this.launchWorker(job); capacity--; changed = true;
        } catch (error) {
          job.status = 'failed'; job.error = sanitize(error.message, this.childEnv); job.finishedAt = now();
          await atomicJson(path.join(this.jobDir(job.id), 'job.json'), job); changed = true;
        }
      }
      return { pending: queued.filter(item => item.status === 'queued').length, changed };
    });
  }
  async repository(input) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('repository must be absolute');
    const repo = await fs.realpath(input);
    const roots = await Promise.all(this.config.allowedRoots.map(root => fs.realpath(root)));
    if (!roots.some(root => repo === root || repo.startsWith(root + path.sep))) throw new Error('Repository outside allowedRoots');
    if (repo !== await fs.realpath(await git(repo, ['rev-parse', '--show-toplevel'], false, this.childEnv))) throw new Error('Use repository root');
    return repo;
  }
  async recover(job) {
    const latest = await this.read(job.id);
    if (terminal.has(latest.status) || latest.status === 'quarantined') return latest;
    const ended = { ...latest, status: 'quarantined', error: 'Worker identity or group needs explicit recovery', finishedAt: now() };
    await atomicJson(path.join(this.jobDir(job.id), 'job.json'), ended); return ended;
  }
  async all() {
    const ids = (await fs.readdir(this.jobsDir)).filter(id => idPattern.test(id));
    const jobs = await Promise.all(ids.map(async id => {
      const job = await this.read(id);
      if (['starting', 'running', 'finalizing'].includes(job.status) && job.workerIdentity && await identityState(job.workerIdentity).catch(() => 'unknown') !== 'same') return this.recover(job);
      if (job.status === 'starting' && !job.workerIdentity && Date.now() - Date.parse(job.admittedAt || job.createdAt) > 15000) return this.recover(job);
      return job;
    }));
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async public(job) {
    const keys = ['id', 'title', 'status', 'repository', 'worktree', 'branch', 'baseCommit', 'parentJobId', 'forkJobId', 'rolloverFromId', 'rolloverSourceSnapshotDigest', 'reviewSourceJobId', 'reviewSourceSnapshotDigest', 'reviewSourceContractDigest', 'createdAt', 'queueExpiresAt', 'admittedAt', 'startedAt', 'finishedAt', 'heartbeatAt', 'lastProgressAt', 'observation', 'sessionFile', 'sessionId', 'effectiveModel', 'lastProgress', 'error', 'warning', 'exitCode', 'numTurns', 'usage', 'usageAvailability', 'permissionDenials', 'permissionDenialsTruncated', 'diffStat', 'diffPreviewTruncated', 'resultOmitted', 'stderrTruncated', 'changedFiles', 'execution', 'verification', 'acceptance', 'acceptanceContract', 'artifacts', 'inputMaterialsDigest', 'inputSnapshotDigest', 'sessionCheckpoint', 'budget', 'providerRecovery'];
    const trusted = new Set(['id', 'status', 'repository', 'worktree', 'branch', 'baseCommit', 'parentJobId', 'forkJobId', 'rolloverFromId', 'rolloverSourceSnapshotDigest', 'reviewSourceJobId', 'reviewSourceSnapshotDigest', 'reviewSourceContractDigest', 'createdAt', 'queueExpiresAt', 'admittedAt', 'startedAt', 'finishedAt', 'heartbeatAt', 'lastProgressAt', 'observation', 'sessionFile', 'sessionId', 'effectiveModel', 'exitCode', 'numTurns', 'usage', 'usageAvailability', 'permissionDenialsTruncated', 'diffPreviewTruncated', 'resultOmitted', 'stderrTruncated', 'changedFiles', 'inputMaterialsDigest', 'inputSnapshotDigest', 'acceptance', 'acceptanceContract']);
    const secrets = await this.headerSecretValues();
    const clean = value => sanitize(value, this.childEnv, secrets);
    const structured = (key, value) => {
      const copy = structuredClone(value);
      if (!copy || typeof copy !== 'object') return copy;
      if (key === 'verification') {
        if (typeof copy.reason === 'string') copy.reason = clean(copy.reason);
        for (const command of copy.commands || []) for (const field of ['stdout', 'stderr']) if (typeof command[field] === 'string') command[field] = clean(command[field]);
      } else if (key === 'artifacts' || key === 'sessionCheckpoint' || key === 'budget') {
        for (const field of ['error', 'reason']) if (typeof copy[field] === 'string') copy[field] = clean(copy[field]);
      } else if (key === 'execution' && typeof copy.stopReason === 'string' && !['stop', 'end_turn', 'error', 'aborted'].includes(copy.stopReason)) copy.stopReason = clean(copy.stopReason);
      return copy;
    };
    job.acceptance = terminal.has(job.status) ? await this.acceptanceFor(job) : job.acceptanceContract ? { status: 'pending_execution', contractDigest: contractDigest(job.acceptanceContract) } : { status: 'not_requested' };
    return Object.fromEntries(keys.filter(key => job[key] !== undefined).map(key => [key,
      trusted.has(key) ? job[key] : ['execution', 'verification', 'artifacts', 'sessionCheckpoint', 'budget'].includes(key) ? structured(key, job[key]) : clean(job[key])]));
  }
  async sourcePathExists(job, relative) {
    const file = path.join(this.jobDir(job.id), 'artifacts', 'private', 'checkpoint.json');
    const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
    if (!handle) return false;
    let checkpoint;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) return false;
      checkpoint = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    if (!checkpoint.complete || checkpoint.baseCommit !== job.baseCommit || !Array.isArray(checkpoint.entries) || checkpoint.entries.length > 4096 ||
      sha(JSON.stringify({ baseCommit: checkpoint.baseCommit, inputMaterialsDigest: checkpoint.inputMaterialsDigest, materialBaseline: checkpoint.materialBaseline, entries: checkpoint.entries })) !== job.artifacts?.inputSnapshotDigest) return false;
    const changed = checkpoint.entries.find(item => item.path === relative);
    if (changed) {
      if (changed.type !== 'file' || !/^a\d{6}$/.test(changed.id) || !/^[0-9a-f]{64}$/.test(changed.sha256) || !Number.isSafeInteger(changed.size) || changed.size < 0 || changed.size > 16 * 1024 * 1024) return false;
      const blob = await fs.open(path.join(this.jobDir(job.id), 'artifacts', 'private', changed.id), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
      if (!blob) return false;
      try {
        const before = await blob.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size !== changed.size) return false;
        const bytes = await blob.readFile(); const after = await blob.stat();
        return before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && sha(bytes) === changed.sha256;
      } finally { await blob.close(); }
    }
    const material = checkpoint.materialBaseline?.find(item => item.path === relative);
    if (material) return /^[0-9a-f]{64}$/.test(material.sha256);
    const tree = await git(job.repository, ['ls-tree', '-z', job.baseCommit, '--', relative], true, this.childEnv);
    return tree.split('\0').some(line => /^(100644|100755) blob [0-9a-f]{40}\t/.test(line) && line.slice(line.indexOf('\t') + 1) === relative);
  }
  async sessionSealed(sessionDir) {
    const file = path.join(sessionDir, 'session-seal.json');
    const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!handle) return false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) throw new Error('Session seal invalid');
      const record = JSON.parse(await handle.readFile('utf8'));
      if (record.version !== 1 || !idPattern.test(record.sourceJobId) || !idPattern.test(record.targetJobId) || !/^[0-9a-f]{64}$/.test(record.codeSnapshotDigest)) throw new Error('Session seal invalid');
      return true;
    } finally { await handle.close(); }
  }
  async ensureSessionSeal(source, targetId) {
    if (await this.sessionSealed(source.sessionDir)) return;
    await fs.mkdir(source.sessionDir, { recursive: true, mode: 0o700 });
    await atomicJson(path.join(source.sessionDir, 'session-seal.json'), { version: 1, sourceJobId: source.id,
      targetJobId: targetId, codeSnapshotDigest: source.artifacts.inputSnapshotDigest });
  }
  async workflowRequestMatches(kind, source, input, job) {
    const repository = source?.repository || await this.repository(input.repository);
    const sourceId = source?.id || null;
    const direct = admissionHash(kind === 'review' ? { ...input, mode: 'review' } : input, repository,
      kind === 'followup' ? sourceId : null, ['review', 'rollover'].includes(kind) ? sourceId : null,
      ['review', 'rollover'].includes(kind), kind === 'review' ? sourceId : null, kind === 'rollover' ? sourceId : null);
    if (job.requestHash === direct) return true;
    return kind === 'followup' && job.requestHash === admissionHash(input, repository, null, sourceId, true, null, sourceId);
  }
  async submitWorkflowStage(kind, sourceId, input, guard) {
    return this.lock(async () => {
      const source = sourceId ? await this.read(sourceId) : null;
      const existing = input.request_id ? (await this.all()).find(job => job.requestId === input.request_id) : null;
      const reason = await guard(source ? await this.public(source) : null, existing);
      if (reason) return { blockedReason: reason };
      if (existing) return { job: await this.public(existing) };
      if (kind === 'delegate') return { job: await this.startUnderLock(input, null) };
      if (kind === 'followup') {
        if (!source) throw new Error('Workflow source missing');
        if (source.sessionCheckpoint?.reason === 'raw_session_too_large' || source.sessionCheckpoint?.complete && source.sessionCheckpoint.size >= Math.floor(16 * 1024 * 1024 * 0.85)) return { job: await this.rolloverUnderLock(sourceId, input, { automatic: true }) };
        return { job: await this.startUnderLock(input, sourceId) };
      }
      if (kind === 'review') {
        if (!source || source.mode === 'review' || !terminal.has(source.status) || !source.artifacts?.checkpointComplete) throw new Error('Review requires terminal source code checkpoint');
        return { job: await this.startUnderLock({ ...input, mode: 'review' }, null, { forkFromId: sourceId, codeOnly: true, reviewSourceId: sourceId }) };
      }
      if (kind === 'rollover') return { job: await this.rolloverUnderLock(sourceId, input, { automatic: false }) };
      throw new Error('Invalid workflow stage');
    });
  }
  async assertSteeringResolved(source) {
    const controls = path.join(this.jobDir(source.id), 'controls');
    const names = await fs.readdir(controls).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const accepted = new Set(source.authoritativeSteerIds || []);
    if (names.some(name => /^processing-[0-9a-f-]{36}\.json$/.test(name) && !accepted.has(name.slice(11, -5)))) throw new Error('Steering delivery unresolved; fresh continuation would lose a possible instruction');
  }
  async acceptanceFor(job) { return evaluateAcceptance(job, relative => this.sourcePathExists(job, relative)); }
  async attestReview(id, { review_job_id, verdict, request_id } = {}) {
    return this.lock(async () => {
      const source = await this.read(id), review = await this.read(review_job_id);
      if (source.status !== 'completed' || source.execution?.status !== 'passed' || !source.artifacts?.checkpointComplete || source.mode === 'review' || !source.acceptanceContract?.require_review) throw new Error('Source has no completed review obligation');
      if (review.mode !== 'review' || review.reviewSourceJobId !== id || review.reviewSourceSnapshotDigest !== source.artifacts?.inputSnapshotDigest ||
        review.artifacts?.checkpointComplete !== true || review.artifacts.inputSnapshotDigest !== source.artifacts.inputSnapshotDigest ||
        review.status !== 'completed' || review.execution?.status !== 'passed' || review.verificationIds?.length && review.verification?.status !== 'passed') throw new Error('Review source, execution or verification mismatch');
      if (review.reviewSourceContractDigest !== contractDigest(source.acceptanceContract)) throw new Error('Review contract changed');
      if (!['approved', 'rejected'].includes(verdict)) throw new Error('Invalid review verdict');
      if (verdict === 'approved' && !['accepted', 'not_requested'].includes((await this.acceptanceFor(review)).status)) throw new Error('Review acceptance incomplete');
      required(request_id, 'request_id', 100);
      const evidence = { authority: 'caller', verdict, reviewJobId: review_job_id, sourceJobId: id,
        inputSnapshotDigest: source.artifacts.inputSnapshotDigest, contractDigest: contractDigest(source.acceptanceContract), manifestSha256: source.artifacts.manifestSha256,
        requestId: request_id, at: now() };
      const existing = source.reviewAttestations?.find(item => item.requestId === request_id);
      if (existing) {
        if (existing.verdict !== verdict || existing.reviewJobId !== review_job_id) throw new Error('request_id already used with different attestation');
        return { ...existing, acceptance: await this.acceptanceFor(source) };
      }
      if ((source.reviewAttestations || []).length >= 32) throw new Error('Review attestation capacity reached');
      source.reviewAttestations = [...(source.reviewAttestations || []), evidence];
      source.acceptance = await this.acceptanceFor(source);
      await atomicJson(path.join(this.jobDir(id), 'job.json'), source);
      return { ...evidence, acceptance: source.acceptance };
    });
  }
  agentSourcePath(name, explicit) {
    return explicit || (this.config.agentDir ? path.join(this.config.agentDir, name) : null);
  }
  // Prefers the already-seeded/owned copy (what Pi will actually use, and for
  // auth.json what seedAgent intentionally preserves even if the source later
  // changes) and falls back to the configured source before the first seed.
  async loadAgentJson(name, explicit) {
    const owned = path.join(this.agentDir, name);
    const isFile = async file => {
      try { return (await fs.stat(file)).isFile(); }
      catch (error) { if (error.code === 'ENOENT') return false; throw new Error(`Invalid ${name} configuration`); }
    };
    if (await isFile(owned)) return this.parseAgentJson(owned, name);
    const source = this.agentSourcePath(name, explicit);
    if (!source) return null;
    if (!await isFile(source)) {
      if (explicit) throw new Error(`Invalid ${name} configuration`);
      return null;
    }
    return this.parseAgentJson(source, name);
  }
  async parseAgentJson(file, name) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw new Error(`Invalid ${name} configuration`); }
  }
  async validateHeaders(provider, model) {
    const [modelsConfig, authConfig] = await Promise.all([
      this.loadAgentJson('models.json', this.config.modelsFile),
      this.loadAgentJson('auth.json', this.config.authFile),
    ]);
    if (modelsConfig) rejectCommands(modelsConfig);
    if (authConfig) rejectCommands(authConfig);
    validateProviderHeaders({ modelsConfig, authConfig, provider, model, childEnv: this.childEnv });
  }
  async sourceConfigDigest() {
    // Model selection must stay frozen in the queue. Owned auth is allowed to
    // rotate (including Pi OAuth refresh) and is revalidated at admission.
    const models = await this.loadAgentJson('models.json', this.config.modelsFile);
    return sha(stable({ models }));
  }
  async headerSecretValues() {
    const modelsConfig = await this.loadAgentJson('models.json', this.config.modelsFile).catch(() => null);
    const authConfig = await this.loadAgentJson('auth.json', this.config.authFile).catch(() => null);
    return [...collectHeaderSecrets(modelsConfig, authConfig, this.childEnv),
      ...(this.config.approvedMcp?.servers || []).flatMap(server => Object.values(server.env || {}).filter(value => typeof value === 'string' && value))];
  }
  async seedAgent() {
    for (const [explicit, name] of [[this.config.modelsFile, 'models.json'], [this.config.authFile, 'auth.json']]) {
      const source = explicit || (this.config.agentDir && await fs.stat(path.join(this.config.agentDir, name)).then(() => true, () => false) ? path.join(this.config.agentDir, name) : null);
      if (!source) continue;
      const target = path.join(this.agentDir, name);
      rejectCommands(await this.parseAgentJson(source, name));
      const existing = await fs.stat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (existing) {
        if (name === 'models.json' && sha(await fs.readFile(source)) !== sha(await fs.readFile(target))) throw new Error('models.json changed; explicit pi-mcp agent reset required after jobs stop');
        continue;
      }
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL); await fs.chmod(target, 0o600);
    }
  }
  async currentSnapshotMatches(source) {
    const temp = await fs.mkdtemp(path.join(this.config.stateDir, 'snapshot-check-'));
    try {
      const current = await snapshotArtifacts({ jobDir: temp, worktree: source.worktree, baseCommit: source.baseCommit,
        config: this.config.artifacts, env: this.childEnv, materialBaseline: source.materialBaseline || [], inputMaterialsDigest: source.inputMaterialsDigest || null });
      return current.checkpointComplete && current.inputSnapshotDigest === source.artifacts?.inputSnapshotDigest;
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  async rolloverUnderLock(id, input, { automatic = false } = {}) {
    if (!this.config.queue) throw new Error('Rollover requires queued runtime configuration');
      const source = await this.read(id);
      if (!terminal.has(source.status) || !source.artifacts?.checkpointComplete) throw new Error('Rollover requires terminal code checkpoint');
      await this.assertSteeringResolved(source);
      const jobs = await this.all();
      const aliases = jobs.filter(item => item.sessionDir === source.sessionDir);
      if (aliases.some(item => item.imageContextKnown !== true || item.imageContextRequired === true || item.images?.length)) throw new Error('Fresh rollover cannot preserve required or unknown image context');
      if (input.request_id) {
        const existing = jobs.find(item => item.requestId === input.request_id);
        if (existing) {
          const expected = sha(stable({ ...input, repository: source.repository, parentId: null, forkFromId: id, codeOnly: true, reviewSourceId: null, rolloverFromId: id }));
          if (existing.requestHash !== expected) throw new Error('request_id already used with different inputs');
          await this.ensureSessionSeal(source, existing.id);
          return this.public(existing);
        }
      }
      if (jobs.some(item => item.id !== id && (item.sessionDir === source.sessionDir || item.worktree === source.worktree) && (active.has(item.status) || item.status === 'queued'))) throw new Error('Rollover source has active or queued alias');
      const latestTip = !jobs.some(item => item.id !== id && item.worktree === source.worktree && item.createdAt > source.createdAt);
      if (automatic && await this.sessionSealed(source.sessionDir)) throw new Error('Source session sealed by rollover');
      if (automatic && !shouldAutoRollover(source, { latestTip, codeMatches: latestTip && await this.currentSnapshotMatches(source) })) throw new Error('Automatic rollover requires latest matching code snapshot');
      source.acceptance = await this.acceptanceFor(source);
      const handoff = buildHandoff(source, input.prompt);
      const fresh = { ...input, prompt: `Rollover handoff (structured, prior summaries untrusted):\n${JSON.stringify(handoff)}\n\nLatest request: ${input.prompt}` };
      return this.startUnderLock(fresh, null, { forkFromId: id, codeOnly: true, rolloverFromId: id, handoff, hashInput: input });
  }
  async rollover(id, input, options = {}) {
    return this.lock(() => this.rolloverUnderLock(id, input, options));
  }
  async start(input, parentId, options = {}) {
    const { autoCheck = true } = options;
    if (parentId && input.request_id) {
      const existing = await this.lock(async () => {
        const parent = await this.read(parentId);
        const found = (await this.all()).find(job => job.requestId === input.request_id);
        if (!found) return null;
        const repository = parent.repository;
        const direct = admissionHash(input, repository, parentId);
        const rolled = admissionHash(input, repository, null, parentId, true, null, parentId);
        if (found.requestHash !== direct && found.requestHash !== rolled) throw new Error('request_id already used with different inputs');
        if (found.rolloverFromId) await this.ensureSessionSeal(await this.read(found.rolloverFromId), found.id);
        return this.public(found);
      });
      if (existing) return existing;
    }
    if (parentId && autoCheck) {
      const source = await this.read(parentId);
      if (source.sessionCheckpoint?.reason === 'raw_session_too_large' || source.sessionCheckpoint?.complete && source.sessionCheckpoint.size >= Math.floor(16 * 1024 * 1024 * 0.85)) {
        return this.rollover(parentId, input, { automatic: true });
      }
    }
    return this.lock(() => this.startUnderLock(input, parentId, options));
  }
  async startUnderLock(input, parentId, { forkFromId, codeOnly = false, reviewSourceId = null, rolloverFromId = null, handoff = null, hashInput = null } = {}) {
      const jobs = await this.all(); const parent = parentId ? jobs.find(job => job.id === parentId) : null;
      const forkSource = forkFromId ? jobs.find(job => job.id === forkFromId) : null;
      if (parentId && !parent) throw new Error('Job not found');
      if (forkFromId && !forkSource) throw new Error('Source job not found');
      const repository = await this.repository(parent?.repository || forkSource?.repository || input.repository);
      required(input.prompt, 'prompt', 100000); if (!parent && !forkSource) required(input.title, 'title', 150);
      if (input.request_id !== undefined) required(input.request_id, 'request_id', 100);
      const mode = reviewSourceId ? 'review' : parent?.mode || forkSource?.mode || input.mode || 'implement';
      if (!['implement', 'review'].includes(mode) || ((parent || forkSource) && !reviewSourceId && input.mode && input.mode !== mode)) throw new Error('Invalid mode');
      if (!parent && !forkSource && input.provider && !input.model) throw new Error('provider override requires model');
      const provider = parent?.provider || forkSource?.provider || input.provider || this.config.provider;
      const model = parent?.model || forkSource?.model || input.model || this.config.model;
      if (!provider || !model) throw new Error('provider and model must be configured or supplied');
      const requestHash = admissionHash(hashInput || input, repository, parentId || null, forkFromId || null, codeOnly, reviewSourceId, rolloverFromId);
      if (input.request_id) {
        const existing = jobs.find(job => job.requestId === input.request_id);
        if (existing) {
          if (existing.requestHash !== requestHash) throw new Error('request_id already used with different inputs');
          if (existing.rolloverFromId) await this.ensureSessionSeal(await this.read(existing.rolloverFromId), existing.id);
          return await this.public(existing);
        }
        const tombstone = await fs.readFile(path.join(this.config.stateDir, 'request-ids', sha(input.request_id) + '.json'), 'utf8').then(JSON.parse, error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (tombstone) throw new Error('request_id belongs to a prior cleaned or unavailable job');
      }
      if (parent && !terminal.has(parent.status)) throw new Error('Parent job is not terminal');
      if (parent && parent.sessionFile && !parent.sessionCheckpoint?.complete) throw new Error('Raw resume unavailable; use pi_rollover from immutable code');
      if (parent && jobs.some(item => item.id !== parent.id && item.worktree === parent.worktree && item.createdAt > parent.createdAt)) throw new Error('Continuation source is not latest worktree tip');
      if (parent && (await this.sessionSealed(parent.sessionDir) || jobs.some(item => item.rolloverFromId && jobs.find(source => source.id === item.rolloverFromId)?.sessionDir === parent.sessionDir))) throw new Error('Source session sealed by rollover');
      if (forkSource && !terminal.has(forkSource.status)) throw new Error('Fork source must be terminal');
      if (forkSource && (!forkSource.artifacts?.checkpointComplete || !codeOnly && !forkSource.sessionCheckpoint?.complete)) throw new Error('Fork source checkpoint incomplete');
      // Preflight before any fresh job/worktree allocation, and on every submission
      // (including followups) so an environment change cannot bypass this check.
      await this.validateHeaders(provider, model);
      if (this.config.retention) {
        let usage;
        try { usage = await scanState(this.config.stateDir, this.config.retention); }
        catch (error) { throw actionableScanError(error); }
        if (!usage.withinLimit) throw new Error('State soft storage admission limit reached');
      }
      if (!this.config.queue && jobs.filter(job => active.has(job.status)).length >= this.config.maxConcurrent) throw new Error('Concurrency limit reached');
      if (this.config.queue && jobs.filter(job => job.status === 'queued').length >= this.config.queue.maxPending) throw new Error('Queue full');
      if (parent && jobs.some(job => (active.has(job.status) || job.status === 'queued') && job.worktree === parent.worktree)) throw new Error('Worktree already active');
      const timeoutSeconds = input.timeout_seconds ?? this.config.defaultTimeoutSeconds;
      const maxTurns = input.max_turns ?? this.config.defaultMaxTurns;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > this.config.maxTimeoutSeconds) throw new Error('Invalid timeout_seconds');
      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new Error('Invalid max_turns');
      const ref = input.base_ref || 'HEAD';
      if (!parent && (typeof ref !== 'string' || ref.startsWith('-') || /[\0\r\n]/.test(ref))) throw new Error('Invalid base_ref');
      const baseCommit = parent?.baseCommit || forkSource?.baseCommit || await git(repository, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], false, this.childEnv);
      const id = `task-${randomUUID()}`; const dir = this.jobDir(id);
      const worktree = parent?.worktree || path.join(this.worktreesDir, id);
      const branch = parent?.branch || `codex/pi/${id.slice(5)}`;
      const dirty = !parent && !forkSource && !!await git(repository, ['status', '--porcelain', '--untracked-files=all'], false, this.childEnv);
      if (parent) {
        const actualWorktree = await fs.realpath(parent.worktree);
        if (actualWorktree !== parent.worktree || actualWorktree !== await fs.realpath(await git(actualWorktree, ['rev-parse', '--show-toplevel'], false, this.childEnv))) throw new Error('Parent worktree changed');
        if (await git(actualWorktree, ['branch', '--show-current'], false, this.childEnv) !== parent.branch) throw new Error('Parent branch changed');
        const sessionsRoot = await fs.realpath(path.join(this.config.stateDir, 'sessions'));
        const sessionRoot = await fs.realpath(parent.sessionDir).catch(() => null);
        if (!sessionRoot || sessionRoot !== parent.sessionDir || !sessionRoot.startsWith(sessionsRoot + path.sep)) throw new Error('Parent session directory changed');
        if (parent.sessionFile) {
          const sessionFile = await fs.realpath(parent.sessionFile).catch(() => null);
          if (!sessionFile || !sessionFile.startsWith(sessionRoot + path.sep)) throw new Error('Parent session unavailable');
        }
      }
      const sessionDir = parent?.sessionDir || path.join(this.config.stateDir, 'sessions', id);
      if ((parent || forkSource) && input.materials !== undefined && stable(input.materials) !== stable((parent || forkSource).materials || [])) throw new Error('Continuation materials must match source selection');
      const materials = (parent || forkSource)?.materials || input.materials || [];
      const source = parent || forkSource;
      if (source && !reviewSourceId) await this.assertSteeringResolved(source);
      const acceptanceContract = reviewSourceId ? normalizeAcceptance(input.acceptance) : inheritAcceptance(source?.acceptanceContract, input.acceptance);
      if (reviewSourceId && acceptanceContract?.require_review) throw new Error('Review cannot require recursive review');
      const verificationIds = input.verification_ids ?? (reviewSourceId ? [] : source?.verificationIds || []);
      if (!Array.isArray(materials) || new Set(materials).size !== materials.length || materials.length > 32 || materials.some(id => typeof id !== 'string' || !this.config.offlineMaterials?.materials?.some(item => item.id === id))) throw new Error('Invalid materials selection');
      if (!Array.isArray(verificationIds) || new Set(verificationIds).size !== verificationIds.length || verificationIds.length > (this.config.verification?.maxSelected ?? 0) || verificationIds.some(id => typeof id !== 'string' || !this.config.verification?.commands?.some(item => item.id === id))) throw new Error('Invalid verification selection');
      if (acceptanceContract?.required_verification_ids.some(id => !verificationIds.includes(id))) throw new Error('Acceptance requires selected verifier IDs');
      if (mode === 'review' && verificationIds.some(id => !this.config.verification.commands.find(item => item.id === id).readOnly)) throw new Error('Review verifier requires administrator readOnly declaration');
      const images = normalizeImages(input.images || []);
      const authoritativeInstructions = handoff?.authoritativeInstructions || extendAuthoritativeInstructions(reviewSourceId ? null : source, (hashInput || input).prompt);
      const job = { id, title: parent?.title || forkSource?.title || input.title, repository, worktree, branch, baseCommit, prompt: input.prompt, images,
        imageContextKnown: reviewSourceId || !source ? true : source.imageContextKnown === true,
        imageContextRequired: reviewSourceId ? images.length > 0 : Boolean(source?.imageContextRequired || source?.images?.length || images.length),
        authoritativeInstructions,
        rootObjective: source?.rootObjective || input.prompt,
        rootConstraints: source?.rootConstraints || { mode, acceptanceContract },
        mode, provider, model, thinkingLevel: parent?.thinkingLevel || input.thinking_level || this.config.thinkingLevel,
        timeoutSeconds, maxTurns, requestId: input.request_id, requestHash, parentJobId: parentId || undefined,
        forkJobId: forkFromId || undefined, codeOnly: codeOnly || undefined, rolloverFromId: rolloverFromId || undefined,
        rolloverSourceSnapshotDigest: rolloverFromId ? forkSource.artifacts.inputSnapshotDigest : undefined,
        handoff: handoff || undefined, lineage: handoff?.lineage || undefined,
        reviewSourceJobId: reviewSourceId || undefined, reviewSourceSnapshotDigest: reviewSourceId ? forkSource?.artifacts?.inputSnapshotDigest : undefined,
        reviewSourceContractDigest: reviewSourceId ? contractDigest(forkSource.acceptanceContract) : undefined,
        sessionDir, sessionFile: parent?.sessionFile, materials, verificationIds, acceptanceContract, status: this.config.queue ? 'queued' : 'starting', createdAt: now(),
        ...(dirty ? { warning: 'Source has uncommitted changes; only selected commit is present in worktree.' } : {}) };
      if (this.config.queue) { job.queueExpiresAt = new Date(Date.now() + this.config.queue.maxWaitSeconds * 1000).toISOString(); job.queueOrder = 1 + jobs.reduce((maximum, item) => Math.max(maximum, item.queueOrder || 0), 0); job.policyDigest = sha(stable(this.frozenPolicy(job))); job.sourceConfigDigest = await this.sourceConfigDigest(); }
      await fs.mkdir(dir, { mode: 0o700 }); if (!this.config.queue) await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
      await atomicJson(path.join(dir, 'job.json'), job);
      if (input.request_id) {
        const tombstones = path.join(this.config.stateDir, 'request-ids'); await fs.mkdir(tombstones, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(tombstones, sha(input.request_id) + '.json'), JSON.stringify({ id, requestHash, createdAt: job.createdAt }), { flag: 'wx', mode: 0o600 });
      }
      if (rolloverFromId) await this.ensureSessionSeal(forkSource, id);
      try {
        if (this.config.queue) { await this.ensureDispatcher(); return { ...await this.public(job), artifactsDir: dir }; }
        if (!parent) await git(repository, ['worktree', 'add', '-b', branch, worktree, baseCommit], false, this.childEnv);
        await this.launchWorker(job);
        return { ...await this.public(job), artifactsDir: dir };
      } catch (error) {
        await atomicJson(path.join(dir, 'job.json'), { ...job, status: 'failed', error: error.message, finishedAt: now() });
        throw error;
      }
  }
  async status(id, waitSeconds = 0) {
    assertId(id); const until = Date.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), 45) * 1000;
    while (true) {
      const job = await this.read(id);
      const current = ['starting', 'running', 'finalizing'].includes(job.status) && job.workerIdentity && await identityState(job.workerIdentity).catch(() => 'unknown') !== 'same' ? await this.recover(job)
        : job.status === 'starting' && !job.workerIdentity && Date.now() - Date.parse(job.admittedAt || job.createdAt) > 15000 ? await this.recover(job)
        : job.status === 'queued' && Date.now() >= Date.parse(job.queueExpiresAt) ? await this.expireQueue(id) : job;
      if (!active.has(current.status) || Date.now() >= until) return await this.public(current);
      await sleep(400);
    }
  }
  async wait(jobIds, { waitSeconds = 45, until = 'any', signal, onProgress } = {}) {
    const ids = Array.isArray(jobIds) ? jobIds : [];
    if (!ids.length || ids.length > 8) throw new Error('job_ids must have 1 to 8 entries');
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate job_ids');
    const mode = until === 'all' ? 'all' : 'any';
    const seconds = Math.min(Math.max(Number(waitSeconds) || 0, 0), 300);
    const settledJobs = new Map(); const pendingJobs = new Map();
    for (const jobId of ids) {
      let job;
      try { job = await this.status(jobId, 0); }
      catch (error) { throw error.code === 'ENOENT' ? new Error(`Job not found: ${jobId}`) : error; }
      (terminal.has(job.status) || job.status === 'quarantined' ? settledJobs : pendingJobs).set(jobId, job);
    }
    const satisfied = () => mode === 'all' ? pendingJobs.size === 0 : settledJobs.size > 0;
    const startedAt = performance.now(); const deadline = startedAt + seconds * 1000;
    let nextProgressAt = 10;
    while (!satisfied() && seconds > 0 && !signal?.aborted && performance.now() < deadline) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(1000, deadline - performance.now()));
        signal?.addEventListener('abort', done, { once: true });
      });
      if (signal?.aborted) break;
      await Promise.all([...pendingJobs.keys()].map(async jobId => {
        const job = await this.status(jobId, 0);
        if (terminal.has(job.status) || job.status === 'quarantined') { pendingJobs.delete(jobId); settledJobs.set(jobId, job); }
        else pendingJobs.set(jobId, job);
      }));
      if (onProgress) {
        const elapsed = Math.floor((performance.now() - startedAt) / 1000);
        if (elapsed >= nextProgressAt) { await onProgress({ progress: elapsed, total: seconds, message: `${settledJobs.size}/${ids.length} settled` }); nextProgressAt = elapsed + 10; }
      }
    }
    const timedOut = !satisfied();
    const byId = new Map([...settledJobs, ...pendingJobs]);
    const next = job => job.status === 'completed' ? 'pi_result for the summary; pi_patch to review or apply'
      : terminal.has(job.status) ? 'pi_result for the error; pi_followup to continue'
      : job.status === 'quarantined' ? 'unsafe: report it; pi_recover inspects ownership' : 'pi_wait again';
    const summarize = (jobId, job) => {
      const diffLines = typeof job.diffStat === 'string' ? job.diffStat.split('\n').filter(line => line.trim()) : [];
      const changedFileCount = Array.isArray(job.changedFiles) ? job.changedFiles.length : 0;
      const summary = { id: jobId, title: typeof job.title === 'string' ? job.title.slice(0, 150) : job.title,
        status: job.status, settled: terminal.has(job.status) || job.status === 'quarantined' };
      if (job.finishedAt !== undefined) summary.finishedAt = job.finishedAt;
      if (typeof job.error === 'string') summary.error = job.error.slice(0, 500);
      if (typeof job.warning === 'string') summary.warning = job.warning.slice(0, 500);
      if (job.verification?.status !== undefined) summary.verification = job.verification.status;
      if (job.acceptance?.status !== undefined) summary.acceptance = job.acceptance.status;
      summary.changedFileCount = changedFileCount; summary.changedFileCountIsLowerBound = changedFileCount >= 200;
      if (diffLines.length) summary.diffSummary = diffLines.at(-1);
      if (typeof job.lastProgress === 'string') summary.lastProgress = job.lastProgress.slice(0, 300);
      if (job.numTurns !== undefined) summary.numTurns = job.numTurns;
      if (job.providerRecovery?.attempts !== undefined) summary.providerRecoveryAttempts = job.providerRecovery.attempts;
      summary.next = next(job);
      return summary;
    };
    return { until: mode, timedOut, elapsedSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(1)),
      settled: ids.filter(jobId => settledJobs.has(jobId)), pending: ids.filter(jobId => pendingJobs.has(jobId)),
      jobs: ids.map(jobId => summarize(jobId, byId.get(jobId))) };
  }
  async expireQueue(id) {
    return this.lock(async () => {
      const job = await this.read(id);
      if (job.status !== 'queued' || Date.now() < Date.parse(job.queueExpiresAt)) return job;
      job.status = 'queue_expired'; job.error = 'Queue wait expired before admission'; job.finishedAt = now();
      await atomicJson(path.join(this.jobDir(id), 'job.json'), job); return job;
    });
  }
  async launchedWorkerIdentity(id) {
    // Identity captured by launchWorker; trusted only if it names the recorded worker pid.
    try {
      const dir = this.jobDir(id);
      const [record, pid] = await Promise.all([fs.readFile(path.join(dir, 'worker-identity.json'), 'utf8').then(JSON.parse), fs.readFile(path.join(dir, 'worker.pid'), 'utf8').then(Number)]);
      return record && Number.isSafeInteger(record.pid) && record.pid === pid ? record : null;
    } catch { return null; }
  }
  async recoverJob(id, { terminate = false } = {}) {
    return this.lock(async () => {
      const job = await this.read(id);
      if (job.status !== 'quarantined') throw new Error('Only quarantined jobs may be recovered');
      if (!job.workerIdentity) job.workerIdentity = await this.launchedWorkerIdentity(id);
      const worker = job.workerIdentity ? await groupState(job.workerIdentity) : { state: 'unknown' };
      const pi = job.piIdentity ? await groupState(job.piIdentity) : job.piPid ? { state: 'unknown' } : { state: 'stopped' };
      const verifiers = [];
      for (const record of job.verifierIdentities || []) verifiers.push(await groupState(record));
      const evidence = { worker, pi, verifiers };
      if (!terminate) return { job_id: id, status: job.status, evidence, recoverable: worker.state === 'stopped' && pi.state === 'stopped' && verifiers.every(item => item.state === 'stopped') };
      if ([worker, pi, ...verifiers].some(item => item.state === 'ambiguous' || item.state === 'unknown')) return { job_id: id, status: 'quarantined', evidence, reason: 'Ambiguous ownership' };
      for (const record of [job.piIdentity, ...(job.verifierIdentities || []), job.workerIdentity].filter(Boolean)) {
        const state = await groupState(record);
        if (state.state === 'owned') {
          const outcome = await stopOwnedGroup(record);
          if (outcome.state !== 'stopped') return { job_id: id, status: 'quarantined', evidence, reason: 'Process group could not be proved stopped' };
        }
      }
      job.status = 'interrupted'; job.error = 'Recovered after verified process-group stop'; job.finishedAt = now();
      await atomicJson(path.join(this.jobDir(id), 'job.json'), job);
      return { job_id: id, status: job.status, evidence };
    });
  }
  async cleanup({ job_ids = [], older_than_days, dry_run = true } = {}) {
    if (!Array.isArray(job_ids) || job_ids.length > 100 || new Set(job_ids).size !== job_ids.length || job_ids.some(id => !idPattern.test(id))) throw new Error('Invalid cleanup job_ids');
    if (older_than_days !== undefined && (!Number.isInteger(older_than_days) || older_than_days < 0 || older_than_days > 3650)) throw new Error('Invalid retention filter');
    if (!dry_run && job_ids.length === 0 && older_than_days === undefined) throw new Error('Destructive cleanup requires an explicit cleanup selection or retention filter');
    const effectiveAge = older_than_days === undefined && dry_run && job_ids.length === 0 ? this.config.retention?.terminalDays : older_than_days;
    return this.lock(async () => {
      const jobs = await this.all();
      const workflowRefs = await readWorkflowReferences(this.config.stateDir);
      const workflowJobIds = new Set(workflowRefs.jobIds);
      const workflowRequestIds = new Set(workflowRefs.requestIds);
      for (const id of job_ids) if (!jobs.some(job => job.id === id)) throw new Error(`Cleanup job not found: ${id}`);
      const selected = jobs.filter(job => job_ids.includes(job.id) || effectiveAge !== undefined && terminal.has(job.status) && Date.now() - Date.parse(job.finishedAt || job.createdAt) >= effectiveAge * 86400000);
      const ids = new Set(selected.map(job => job.id)); const refused = [], candidates = [];
      for (const job of selected) {
        const reason = !terminal.has(job.status) ? 'not_terminal' : workflowJobIds.has(job.id) || workflowRequestIds.has(job.requestId) || jobs.some(other => !ids.has(other.id) && (other.parentJobId === job.id || other.forkJobId === job.id || other.worktree === job.worktree || other.sessionDir === job.sessionDir)) ? 'referenced' : job.exportedAt ? 'export_reference' : null;
        if (reason) { refused.push({ id: job.id, reason }); continue; }
        if (!job.worktree.startsWith(this.worktreesDir + path.sep) || path.dirname(job.worktree) !== this.worktreesDir || !job.branch.startsWith('codex/pi/')) { refused.push({ id: job.id, reason: 'ownership_path' }); continue; }
        candidates.push(job);
      }
      if (dry_run) return { dryRun: true, candidates: candidates.map(job => job.id), refused };
      if (refused.length) throw new Error(`Cleanup refused: ${JSON.stringify(refused)}`);
      for (const job of candidates.filter(item => item.rolloverFromId)) {
        const source = jobs.find(item => item.id === job.rolloverFromId);
        if (source && !ids.has(source.id)) await this.ensureSessionSeal(source, job.id);
      }
      const sessionsRoot = path.join(this.config.stateDir, 'sessions');
      const sessions = new Set(candidates.map(job => job.sessionDir));
      for (const sessionDir of sessions) {
        if (!sessionDir || path.dirname(sessionDir) !== sessionsRoot || !idPattern.test(path.basename(sessionDir))) throw new Error('Cleanup session ownership path invalid');
        const present = await fs.realpath(sessionDir).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (present && (present !== sessionDir || !(await fs.lstat(sessionDir)).isDirectory())) throw new Error('Cleanup session ownership changed');
      }
      const worktrees = new Set();
      for (const job of candidates) {
        if (worktrees.has(job.worktree)) continue; worktrees.add(job.worktree);
        const present = await fs.realpath(job.worktree).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (present) {
          if (present !== job.worktree || await git(job.worktree, ['rev-parse', '--show-toplevel'], false, this.childEnv) !== job.worktree || await git(job.worktree, ['branch', '--show-current'], false, this.childEnv) !== job.branch) throw new Error('Cleanup worktree ownership changed');
          if (await git(job.repository, ['rev-parse', job.branch], false, this.childEnv) !== job.baseCommit) throw new Error('Cleanup branch contains commits');
          await git(job.repository, ['worktree', 'remove', '--force', job.worktree], false, this.childEnv);
          await git(job.repository, ['branch', '-D', job.branch], false, this.childEnv);
        }
      }
      for (const job of candidates) {
        const dir = this.jobDir(job.id);
        if (await fs.realpath(dir) !== dir || JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8')).id !== job.id) throw new Error('Cleanup job ownership changed');
        await fs.rm(dir, { recursive: true });
      }
      for (const sessionDir of sessions) await fs.rm(sessionDir, { recursive: true, force: true });
      return { dryRun: false, removed: candidates.map(job => job.id), refused: [] };
    });
  }
  async result(id) {
    const job = await this.status(id); const dir = this.jobDir(id);
    return this.lock(async () => {
      const headerSecrets = await this.headerSecretValues();
      const preview = async (name, max) => {
        const handle = await fs.open(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (!handle) return { text: '', truncated: false };
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) return { text: '', truncated: true };
          const buf = Buffer.alloc(stat.size); let offset = 0;
          while (offset < buf.length) { const read = await handle.read(buf, offset, buf.length - offset, offset); if (!read.bytesRead) throw new Error('Result file changed'); offset += read.bytesRead; }
          const clean = sanitize(buf.toString('utf8'), this.childEnv, headerSecrets);
          return { text: clean.slice(0, max), truncated: clean.length > max };
        } finally { await handle.close(); }
      };
      const [result, stderr, diff] = await Promise.all([preview('result.txt', 24000), preview('stderr.log', 4000), preview('changes.patch', 24000)]);
      return { ...job, result: result.text, resultPreviewTruncated: result.truncated || !!job.resultOmitted,
        stderrTail: stderr.text, stderrPreviewTruncated: stderr.truncated || !!job.stderrTruncated,
        diffPreview: diff.text, diffPreviewTruncated: diff.truncated || !!job.diffPreviewTruncated, artifactsDir: dir,
        untrackedNote: 'Patch contains tracked changes only; inspect artifacts for new files.' };
    });
  }
  async artifacts(id, options = {}) { return this.lock(async () => { const job = await this.read(id); if (!terminal.has(job.status)) throw new Error('Artifacts require a terminal job'); return listArtifacts(this.jobDir(id), options); }); }
  async readArtifact(id, options = {}) { return this.lock(async () => { const job = await this.read(id); if (!terminal.has(job.status)) throw new Error('Artifacts require a terminal job'); return readArtifact(this.jobDir(id), options); }); }
  async fork(id, input) {
    if (!this.config.queue) throw new Error('Fork requires queued runtime configuration');
    return this.start(input, null, { forkFromId: id });
  }
  async review(id, input) {
    if (!this.config.queue) throw new Error('Review requires queued runtime configuration');
    const source = await this.read(id);
    if (source.mode === 'review' || !terminal.has(source.status) || !source.artifacts?.checkpointComplete) throw new Error('Review requires terminal source code checkpoint');
    return this.start({ ...input, mode: 'review' }, null, { forkFromId: id, codeOnly: true, reviewSourceId: id });
  }
  async steer(id, { message, images = [] } = {}) {
    required(message, 'message', 2000);
    const normalized = normalizeImages(images);
    const controlId = randomUUID();
    const dir = this.jobDir(id);
    await this.lock(async () => {
      const job = await this.read(id);
      if (job.status !== 'running') throw new Error('Steering requires a running job');
      const controls = path.join(dir, 'controls'); await fs.mkdir(controls, { recursive: true, mode: 0o700 });
      const names = await fs.readdir(controls);
      if (names.length >= 120) throw new Error('Steering receipt store full');
      if (names.filter(name => name.startsWith('pending-')).length >= 8) throw new Error('Steering queue full');
      await atomicJson(path.join(controls, `pending-${controlId}.json`), { id: controlId, message, images, createdAt: now() });
    });
    let latestAck = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const ack = await fs.readFile(path.join(dir, 'controls', `ack-${controlId}.json`), 'utf8').then(JSON.parse, error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (ack) { latestAck = ack; if (ack.status !== 'received') return { control_id: controlId, status: ack.status, disposition: ack.disposition || null }; }
      await sleep(100);
    }
    if (latestAck) return { control_id: controlId, status: 'received', disposition: null };
    return { control_id: controlId, status: 'unknown', note: 'No worker acknowledgement; this control will not be replayed automatically.' };
  }
  async cancel(id) {
    await this.status(id);
    return this.lock(async () => {
      const current = await this.read(id);
      if (current.status === 'queued') {
        current.status = 'cancelled'; current.finishedAt = now(); current.error = 'Cancelled before admission';
        await atomicJson(path.join(this.jobDir(id), 'job.json'), current);
        return { ...await this.public(current), cancellationRequested: true };
      }
      if (!['starting', 'running', 'finalizing'].includes(current.status)) return this.public(current);
      await fs.writeFile(path.join(this.jobDir(id), 'cancel'), now(), { mode: 0o600 });
      return { ...await this.public(current), cancellationRequested: true };
    });
  }
  async health() {
    const version = (await exec(this.config.piPath, [...(this.config.piArgs || []), '--version'], { env: this.childEnv, timeout: 10000 })).stdout.trim();
    if (!/\b1\.4\.0\b/.test(version)) throw new Error(`Unsupported Pi version: ${version}`);
    const which = async name => { for (const dir of (this.childEnv.PATH || '').split(path.delimiter)) if (await fs.access(path.join(dir, name), fs.constants.X_OK).then(() => true, () => false)) return true; return false; };
    const fileExists = async file => !!file && !!await fs.stat(file).then(stat => stat.isFile(), () => false);
    const authenticationPresent = await fileExists(path.join(this.agentDir, 'auth.json')) || await fileExists(this.config.authFile)
      || (this.config.agentDir && await fileExists(path.join(this.config.agentDir, 'auth.json')))
      || !!this.config.envAllowlist?.some(key => /KEY|TOKEN|AUTH|CREDENTIAL|SECRET/i.test(key) && this.childEnv[key]);
    const jobs = await this.all();
    const retentionDays = this.config.retention?.terminalDays ?? 30;
    const retentionCandidates = jobs.filter(job => terminal.has(job.status) && Date.now() - Date.parse(job.finishedAt || job.createdAt) >= retentionDays * 86400000);
    let storage = null;
    if (this.config.retention) {
      // Health must stay usable even past the scan bound; report the problem
      // instead of throwing it.
      storage = await scanState(this.config.stateDir, this.config.retention).catch(error => ({ error: actionableScanError(error).message }));
    }
    return { version, allowedRoots: this.config.allowedRoots, stateDir: this.config.stateDir, maxConcurrent: this.config.maxConcurrent,
      activeJobs: jobs.filter(job => active.has(job.status)).length,
      authenticationPresent: !!authenticationPresent,
      authenticationNote: 'Credential presence does not prove authentication.', requiredTools: { rg: await which('rg'), fd: await which('fd') },
      storage,
      queuedJobs: jobs.filter(job => job.status === 'queued').length, retentionCandidateCount: retentionCandidates.length,
      retentionCandidateIdsPreview: retentionCandidates.slice(0, 20).map(job => job.id), retentionDays };
  }
}
