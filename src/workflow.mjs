import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { withOwnershipLock } from './ownership.mjs';

const GOAL = /^goal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB = /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const KINDS = new Set(['delegate', 'followup', 'review', 'rollover']);
const GATES = new Set(['execution', 'verification', 'acceptance']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'turn_limit', 'interrupted', 'queue_expired', 'budget_limit', 'budget_unavailable', 'context_limit', 'idle_timeout', 'tool_failure_limit']);
const INPUT_KEYS = new Set(['repository', 'title', 'prompt', 'provider', 'model', 'mode', 'base_ref', 'timeout_seconds', 'max_turns', 'verification_ids', 'materials', 'acceptance']);
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.has(key));
const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

function validateInput(raw, kind) {
  if (!exact(raw, INPUT_KEYS) || typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 100_000) throw new Error('Invalid workflow stage input');
  for (const key of ['repository', 'title', 'provider', 'model', 'mode', 'base_ref']) if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key] || raw[key].length > 500)) throw new Error('Invalid workflow stage input');
  if (kind === 'delegate' && (typeof raw.repository !== 'string' || !path.isAbsolute(raw.repository) || typeof raw.title !== 'string' || !raw.title || raw.title.length > 150)) throw new Error('Invalid workflow delegate');
  if (kind !== 'delegate' && (raw.repository !== undefined || raw.base_ref !== undefined || raw.mode !== undefined || raw.provider !== undefined || raw.model !== undefined)) throw new Error('Invalid workflow continuation');
  for (const key of ['timeout_seconds', 'max_turns']) if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || raw[key] < 1 || raw[key] > 7200)) throw new Error('Invalid workflow stage input');
  for (const key of ['verification_ids', 'materials']) if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].length > 32 || new Set(raw[key]).size !== raw[key].length || raw[key].some(item => typeof item !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item)))) throw new Error('Invalid workflow stage input');
  if (raw.acceptance !== undefined && (!raw.acceptance || typeof raw.acceptance !== 'object' || Array.isArray(raw.acceptance) || Buffer.byteLength(stable(raw.acceptance)) > 16_384)) throw new Error('Invalid workflow stage input');
  return structuredClone(raw);
}

function validateCreate(raw) {
  if (!exact(raw, new Set(['version', 'title', 'stages', 'budget'])) || raw.version !== 1 || !Array.isArray(raw.stages) || !raw.stages.length || raw.stages.length > 16) throw new Error('Invalid workflow');
  if (raw.title !== undefined && (typeof raw.title !== 'string' || !raw.title || raw.title.length > 150)) throw new Error('Invalid workflow title');
  const stages = raw.stages.map((stage, index) => {
    if (!exact(stage, new Set(['kind', 'input', 'requires'])) || !KINDS.has(stage.kind) || index === 0 && stage.kind !== 'delegate') throw new Error('Invalid workflow stage');
    if (stage.requires !== undefined && (!Array.isArray(stage.requires) || stage.requires.length > 3 || new Set(stage.requires).size !== stage.requires.length || stage.requires.some(gate => !GATES.has(gate)))) throw new Error('Invalid workflow gates');
    return { kind: stage.kind, input: validateInput(stage.input, stage.kind), requires: [...(stage.requires ?? ['execution'])] };
  });
  let budget = null;
  if (raw.budget !== undefined) {
    if (!exact(raw.budget, new Set(['maxTotalTokens', 'maxCostUsd'])) || !Object.keys(raw.budget).length) throw new Error('Invalid workflow budget');
    budget = {};
    if (raw.budget.maxTotalTokens !== undefined) { if (!Number.isSafeInteger(raw.budget.maxTotalTokens) || raw.budget.maxTotalTokens < 1 || raw.budget.maxTotalTokens > 1_000_000_000) throw new Error('Invalid workflow budget'); budget.maxTotalTokens = raw.budget.maxTotalTokens; }
    if (raw.budget.maxCostUsd !== undefined) { if (typeof raw.budget.maxCostUsd !== 'number' || !Number.isFinite(raw.budget.maxCostUsd) || raw.budget.maxCostUsd <= 0 || raw.budget.maxCostUsd > 1_000_000) throw new Error('Invalid workflow budget'); budget.maxCostUsd = raw.budget.maxCostUsd; }
  }
  return { stages, budget };
}

function validateStore(store) {
  if (!exact(store, new Set(['version', 'id', 'title', 'createdAt', 'planDigest', 'stages', 'budget', 'index', 'cancelRequested', 'cancelIntent', 'released', 'countedJobs', 'observedUsage', 'usageUnavailable', 'blockedReason'])) || store.version !== 1 || !GOAL.test(store.id) || typeof store.createdAt !== 'string' || !Number.isFinite(Date.parse(store.createdAt)) || !DIGEST.test(store.planDigest) || !Array.isArray(store.stages) || !store.stages.length || store.stages.length > 16 || !Number.isInteger(store.index) || store.index < 0 || store.index > store.stages.length || typeof store.cancelRequested !== 'boolean' || typeof store.released !== 'boolean' || !Array.isArray(store.countedJobs) || store.countedJobs.length > 16 || !exact(store.observedUsage, new Set(['totalTokens', 'costUsd'])) || !Number.isFinite(store.observedUsage.totalTokens) || store.observedUsage.totalTokens < 0 || !Number.isFinite(store.observedUsage.costUsd) || store.observedUsage.costUsd < 0 || !exact(store.usageUnavailable, new Set(['totalTokens', 'costUsd'])) || typeof store.usageUnavailable.totalTokens !== 'boolean' || typeof store.usageUnavailable.costUsd !== 'boolean') throw new Error('Corrupt workflow store');
  validateCreate({ version: 1, ...(store.title == null ? {} : { title: store.title }), stages: store.stages.map(({ kind, input, requires }) => ({ kind, input, requires })), ...(store.budget ? { budget: store.budget } : {}) });
  if (store.planDigest !== sha(stable({ stages: store.stages.map(({ kind, input, requires }) => ({ kind, input, requires })), budget: store.budget }))) throw new Error('Workflow plan changed');
  for (const [index, stage] of store.stages.entries()) {
    if (!exact(stage, new Set(['kind', 'input', 'requires', 'jobId', 'sourceJobId', 'codeDigest', 'contractDigest', 'intent']))) throw new Error('Corrupt workflow stage');
    if (stage.jobId !== undefined && !JOB.test(stage.jobId) || stage.sourceJobId !== undefined && !JOB.test(stage.sourceJobId)) throw new Error('Corrupt workflow reference');
    if (stage.codeDigest !== undefined && !DIGEST.test(stage.codeDigest) || stage.contractDigest !== undefined && !DIGEST.test(stage.contractDigest)) throw new Error('Corrupt workflow digest');
    if (stage.intent) {
      if (!exact(stage.intent, new Set(['requestId', 'sourceJobId', 'sourceCodeDigest', 'sourceContractDigest', 'payloadDigest', 'preparedAt'])) || typeof stage.intent.requestId !== 'string' || stage.intent.requestId.length > 100 || !DIGEST.test(stage.intent.payloadDigest) || stage.intent.sourceJobId !== null && !JOB.test(stage.intent.sourceJobId) || stage.intent.sourceCodeDigest !== null && !DIGEST.test(stage.intent.sourceCodeDigest) || stage.intent.sourceContractDigest !== null && !DIGEST.test(stage.intent.sourceContractDigest)) throw new Error('Corrupt workflow intent');
      const identity = { code: stage.intent.sourceCodeDigest, contract: stage.intent.sourceContractDigest };
      if (stage.intent.requestId !== `wf-${store.id.slice(5)}-${index}` ||
        (stage.sourceJobId ?? null) !== stage.intent.sourceJobId ||
        stage.intent.payloadDigest !== sha(stable({ kind: stage.kind, sourceJobId: stage.intent.sourceJobId,
          sourceIdentity: identity, payload: { ...stage.input, request_id: stage.intent.requestId } }))) throw new Error('Corrupt workflow intent binding');
    }
  }
  if (store.cancelIntent && (!exact(store.cancelIntent, new Set(['jobId', 'requestId', 'at', 'deliveredAt'])) || store.cancelIntent.jobId !== null && !JOB.test(store.cancelIntent.jobId) || store.cancelIntent.requestId !== null && typeof store.cancelIntent.requestId !== 'string')) throw new Error('Corrupt workflow cancellation');
  if (store.blockedReason !== null && store.blockedReason !== undefined && !['active_child', 'child_failed', 'usage_unavailable', 'budget_limit', 'missing_source', 'active_source', 'source_code_unavailable', 'source_code_changed', 'source_contract_changed', 'execution_gate', 'verification_gate', 'acceptance_gate'].includes(store.blockedReason)) throw new Error('Corrupt workflow status');
  if (store.countedJobs.some(id => !JOB.test(id)) || new Set(store.countedJobs).size !== store.countedJobs.length) throw new Error('Corrupt workflow usage');
  return store;
}

async function readSafe(file) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_STORE_BYTES) throw new Error('Unsafe workflow store');
    const text = await handle.readFile('utf8');
    return validateStore(JSON.parse(text));
  } finally { await handle.close(); }
}

async function writeStore(file, value, exclusive = false) {
  validateStore(value);
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error('Workflow store too large');
  if (exclusive) { await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 }); return; }
  const tmp = path.join(path.dirname(file), 'locks', `.${path.basename(file)}.${randomUUID()}.tmp`);
  try { await fs.writeFile(tmp, text, { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

function paths(stateDir) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('Invalid workflow state directory');
  return { dir: path.join(stateDir, 'workflows'), locks: path.join(stateDir, 'workflows', 'locks') };
}

/** Called by cleanup under submit.lock; never takes a workflow lock. */
export async function readWorkflowReferences(stateDir) {
  const { dir } = paths(stateDir);
  const root = await fs.lstat(stateDir);
  if (!root.isDirectory() || root.isSymbolicLink() || await fs.realpath(stateDir) !== stateDir) throw new Error('Unsafe workflow state root');
  const stat = await fs.lstat(dir).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return { jobIds: [], requestIds: [] };
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe workflow directory');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (entries.length > 1025) throw new Error('Workflow store count exceeded');
  const jobIds = new Set(); const requestIds = new Set();
  for (const entry of entries) {
    if (entry.name === 'locks' && entry.isDirectory()) continue;
    if (!entry.isFile() || !/^goal-[0-9a-f-]{36}\.json$/i.test(entry.name)) throw new Error('Unsafe workflow entry');
    const store = await readSafe(path.join(dir, entry.name));
    if (entry.name !== `${store.id}.json`) throw new Error('Workflow filename does not match store');
    if (store.released) continue;
    for (const stage of store.stages) {
      if (stage.jobId) jobIds.add(stage.jobId);
      if (stage.sourceJobId) jobIds.add(stage.sourceJobId);
      if (stage.intent) { requestIds.add(stage.intent.requestId); if (stage.intent.sourceJobId) jobIds.add(stage.intent.sourceJobId); }
    }
  }
  return { jobIds: [...jobIds], requestIds: [...requestIds] };
}

function publicStatus(store) {
  const current = store.stages[store.index];
  const nextAction = store.released ? 'released' : store.cancelRequested ? 'cancel_requested' :
    store.blockedReason === 'acceptance_gate' ? 'await_attestation' : store.blockedReason === 'active_source' ? 'await_source' :
    store.blockedReason === 'active_child' ? 'await_child' : store.blockedReason ? 'blocked' :
    current?.jobId ? 'await_child' : current ? 'advance' : 'complete';
  return { id: store.id, title: store.title, stage: store.index, totalStages: store.stages.length, nextAction,
    activeJobId: current?.jobId ?? null, blockedReason: store.blockedReason ?? null, cancelRequested: store.cancelRequested, released: store.released,
    observedUsage: { totalTokens: store.usageUnavailable.totalTokens ? null : store.observedUsage.totalTokens,
      costUsd: store.usageUnavailable.costUsd ? null : store.observedUsage.costUsd }, usageUnavailable: { ...store.usageUnavailable },
    budget: store.budget ? { ...store.budget, inFlightOvershootPossible: true } : null,
    stages: store.stages.map(stage => ({ kind: stage.kind, jobId: stage.jobId ?? null, sourceJobId: stage.sourceJobId ?? null, codeDigest: stage.codeDigest ?? null, contractDigest: stage.contractDigest ?? null, requestId: stage.intent?.requestId ?? null })) };
}

function sourceFor(store) {
  for (let i = store.index - 1; i >= 0; i--) if (store.stages[i].kind !== 'review' && store.stages[i].jobId) return store.stages[i].jobId;
  return null;
}

async function freshJob(manager, raw) { return typeof manager.public === 'function' ? manager.public(raw) : raw; }

function gate(source, stage) {
  if (!source) return stage.kind === 'delegate' ? null : 'missing_source';
  if (!TERMINAL.has(source.status)) return 'active_source';
  if (source.status !== 'completed' || source.execution?.status !== 'passed') return 'execution_gate';
  if (stage.kind !== 'delegate' && !DIGEST.test(source.artifacts?.inputSnapshotDigest)) return 'source_code_unavailable';
  if (stage.requires.includes('verification') && source.verification?.status !== 'passed') return 'verification_gate';
  if (stage.kind !== 'review' && source.acceptance?.status && source.acceptance.status !== 'not_requested' && source.acceptance.status !== 'accepted') return 'acceptance_gate';
  if (stage.requires.includes('acceptance') && source.acceptance?.status !== 'accepted' && !(stage.kind === 'review' && source.acceptance?.status === 'pending_review')) return 'acceptance_gate';
  return null;
}

function sourceDigests(source) {
  return { code: source?.artifacts?.inputSnapshotDigest ?? null, contract: source?.acceptance?.contractDigest ?? null };
}

async function existingMatches(manager, stage, job, sourceJob) {
  if (!JOB.test(job?.id) || job.requestId !== stage.intent.requestId) return false;
  const source = stage.intent.sourceJobId;
  if (stage.kind === 'followup' && job.parentJobId !== source &&
    (job.rolloverFromId !== source || job.rolloverSourceSnapshotDigest !== stage.intent.sourceCodeDigest)) return false;
  if (stage.kind === 'review' && (job.reviewSourceJobId !== source || job.reviewSourceSnapshotDigest !== stage.intent.sourceCodeDigest ||
    stage.intent.sourceContractDigest && job.reviewSourceContractDigest !== stage.intent.sourceContractDigest)) return false;
  if (stage.kind === 'rollover' && (job.rolloverFromId !== source || job.rolloverSourceSnapshotDigest !== stage.intent.sourceCodeDigest)) return false;
  if (stage.kind === 'delegate' && (job.parentJobId || job.reviewSourceJobId || job.rolloverFromId)) return false;
  if (typeof manager.workflowRequestMatches === 'function' && !await manager.workflowRequestMatches(stage.kind, sourceJob, { ...stage.input, request_id: stage.intent.requestId }, job)) return false;
  return true;
}

function validatePreparedSource(stage, sourceJobId, source) {
  const identity = sourceDigests(source);
  if (stage.intent.sourceJobId !== sourceJobId || stage.intent.sourceCodeDigest !== identity.code ||
    stage.intent.sourceContractDigest !== identity.contract ||
    stage.intent.payloadDigest !== sha(stable({ kind: stage.kind, sourceJobId, sourceIdentity: identity,
      payload: { ...stage.input, request_id: stage.intent.requestId } }))) throw new Error('Workflow intent or source changed');
  return identity;
}

function finalAcceptanceGate(source) {
  return source?.acceptance?.status === 'accepted' || source?.acceptance?.status === 'not_requested' ? null : 'acceptance_gate';
}

function countedUsage(store, job) {
  if (store.countedJobs.includes(job.id)) return;
  store.countedJobs.push(job.id);
  const usage = job.usage ?? {};
  const components = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const componentTotal = components.every(key => Number.isFinite(usage[key]) && usage[key] >= 0) ? components.reduce((sum, key) => sum + usage[key], 0) : null;
  const measuredTotal = Number.isFinite(usage.totalTokens) && usage.totalTokens > 0 ? usage.totalTokens : Number.isFinite(usage.total) && usage.total > 0 ? usage.total : componentTotal > 0 ? componentTotal : null;
  const total = job.usageAvailability?.totalTokens === true && job.usageAvailability.observedResponses > 0 ? measuredTotal : null;
  const cost = job.usageAvailability?.costUsd === true && job.usageAvailability.observedResponses > 0 &&
    Number.isFinite(usage.cost?.total) && usage.cost.total > 0 ? usage.cost.total : null;
  if (total === null) store.usageUnavailable.totalTokens = true;
  else store.observedUsage.totalTokens += total;
  if (cost === null) store.usageUnavailable.costUsd = true;
  else store.observedUsage.costUsd += cost;
}

function budgetBlock(store) {
  if (!store.budget) return null;
  if (store.budget.maxTotalTokens !== undefined && store.usageUnavailable.totalTokens || store.budget.maxCostUsd !== undefined && store.usageUnavailable.costUsd) return 'usage_unavailable';
  if (store.budget.maxTotalTokens !== undefined && store.observedUsage.totalTokens >= store.budget.maxTotalTokens || store.budget.maxCostUsd !== undefined && store.observedUsage.costUsd >= store.budget.maxCostUsd) return 'budget_limit';
  return null;
}

export class Workflow {
  constructor(manager) { if (!manager?.config?.stateDir || typeof manager.lock !== 'function') throw new Error('Workflow requires Manager'); this.manager = manager; this.stateDir = manager.config.stateDir; }
  async ensureDirs() {
    const { dir, locks } = paths(this.stateDir);
    if (await fs.realpath(this.stateDir) !== this.stateDir || !(await fs.lstat(this.stateDir)).isDirectory()) throw new Error('Unsafe workflow state root');
    for (const target of [dir, locks]) {
      await fs.mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(target) !== target) throw new Error('Unsafe workflow directory');
    }
    return dir;
  }
  file(id) { if (!GOAL.test(id)) throw new Error('Invalid goal id'); return path.join(paths(this.stateDir).dir, `${id}.json`); }
  async withGoal(id, run) { if (!GOAL.test(id)) throw new Error('Invalid goal id'); await this.ensureDirs(); return withOwnershipLock(path.join(paths(this.stateDir).locks, `${id}.lock`), run); }
  async refreshCompletionGate(store, file) {
    const last = store.stages.at(-1);
    const sourceJobId = last.kind === 'review' ? sourceFor(store) : last.jobId;
    await this.manager.lock(async () => {
      const source = sourceJobId ? await freshJob(this.manager, await this.manager.read(sourceJobId)) : null;
      const reviewer = last.kind === 'review' && last.jobId ? await freshJob(this.manager, await this.manager.read(last.jobId)) : null;
      store.blockedReason = reviewer ? finalAcceptanceGate(reviewer) || finalAcceptanceGate(source) : finalAcceptanceGate(source);
      await writeStore(file, store);
    });
  }
  async create(input) {
    const normalized = validateCreate(input);
    const dir = await this.ensureDirs();
    return withOwnershipLock(path.join(paths(this.stateDir).locks, 'create.lock'), async () => {
      const entries = await fs.readdir(dir);
      if (entries.filter(name => name.endsWith('.json')).length >= 1024 || entries.length > 1025) throw new Error('Workflow store capacity reached');
      await readWorkflowReferences(this.stateDir);
      const id = `goal-${randomUUID()}`;
      const store = { version: 1, id, title: input.title ?? null, createdAt: now(), stages: normalized.stages, budget: normalized.budget,
        planDigest: sha(stable({ stages: normalized.stages, budget: normalized.budget })), index: 0,
        cancelRequested: false, released: false, countedJobs: [], observedUsage: { totalTokens: 0, costUsd: 0 }, usageUnavailable: { totalTokens: false, costUsd: false }, blockedReason: null };
      await writeStore(path.join(dir, `${id}.json`), store, true);
      return publicStatus(store);
    });
  }
  async status(id) { return publicStatus(await readSafe(this.file(id))); }
  async advance(id) {
    return this.withGoal(id, async () => {
      const file = this.file(id); const store = await readSafe(file);
      if (store.released) throw new Error('Workflow released');
      if (store.cancelRequested) { await this.deliverCancel(store, file); await this.countTerminalCancellationUsage(store, file); return publicStatus(store); }
      let stage = store.stages[store.index];
      if (!stage) {
        await this.refreshCompletionGate(store, file);
        return publicStatus(store);
      }
      if (stage.jobId) {
        const job = await this.manager.lock(async () => freshJob(this.manager, await this.manager.read(stage.jobId)));
        if (!TERMINAL.has(job.status)) { store.blockedReason = 'active_child'; await writeStore(file, store); return publicStatus(store); }
        countedUsage(store, job);
        if (job.status !== 'completed') { store.blockedReason = 'child_failed'; await writeStore(file, store); return publicStatus(store); }
        if (stage.kind === 'review' && finalAcceptanceGate(job)) { store.blockedReason = 'acceptance_gate'; await writeStore(file, store); return publicStatus(store); }
        if (DIGEST.test(job.artifacts?.inputSnapshotDigest)) stage.codeDigest = job.artifacts.inputSnapshotDigest;
        if (DIGEST.test(job.acceptance?.contractDigest)) stage.contractDigest = job.acceptance.contractDigest;
        store.index++;
        store.blockedReason = null;
        await writeStore(file, store);
        stage = store.stages[store.index];
        if (!stage) {
          await this.refreshCompletionGate(store, file);
          return publicStatus(store);
        }
      }
      const budgetReason = budgetBlock(store);
      if (budgetReason) { store.blockedReason = budgetReason; await writeStore(file, store); return publicStatus(store); }
      const sourceJobId = store.index === 0 ? null : sourceFor(store);
      await this.manager.lock(async () => {
        const source = sourceJobId ? await freshJob(this.manager, await this.manager.read(sourceJobId)) : null;
        if (stage.intent) {
          validatePreparedSource(stage, sourceJobId, source);
          const existing = (await this.manager.all()).find(job => job.requestId === stage.intent.requestId);
          if (existing) {
            if (!await existingMatches(this.manager, stage, existing, source)) throw new Error('Workflow request ID points to a different child');
            stage.jobId = existing.id; await writeStore(file, store); return;
          }
        }
        const reason = store.index === 0 ? null : gate(source, stage);
        if (reason) { store.blockedReason = reason; await writeStore(file, store); return; }
        const sourceIdentity = sourceDigests(source);
        if (!stage.intent) {
          const requestId = `wf-${store.id.slice(5)}-${store.index}`;
          const payload = { ...stage.input, request_id: requestId };
          stage.sourceJobId = sourceJobId ?? undefined;
          stage.intent = { requestId, sourceJobId, sourceCodeDigest: sourceIdentity.code, sourceContractDigest: sourceIdentity.contract,
            payloadDigest: sha(stable({ kind: stage.kind, sourceJobId, sourceIdentity, payload })), preparedAt: now() };
          store.blockedReason = null;
          await writeStore(file, store);
        }
      });
      if (store.blockedReason || stage.jobId) return publicStatus(store);
      const input = { ...stage.input, request_id: stage.intent.requestId };
      let created;
      if (typeof this.manager.submitWorkflowStage === 'function') {
        const submitted = await this.manager.submitWorkflowStage(stage.kind, sourceJobId, input, async (source, existing) => {
          validatePreparedSource(stage, sourceJobId, source);
          if (existing) {
            if (!await existingMatches(this.manager, stage, existing, source)) throw new Error('Workflow request ID points to a different child');
            return null;
          }
          return store.index === 0 ? null : gate(source, stage);
        });
        if (submitted.blockedReason) { store.blockedReason = submitted.blockedReason; await writeStore(file, store); return publicStatus(store); }
        created = submitted.job;
      } else if (stage.kind === 'delegate') created = await this.manager.start(input);
      else if (stage.kind === 'followup') created = await this.manager.start(input, sourceJobId);
      else if (stage.kind === 'review') created = await this.manager.review(sourceJobId, input);
      else created = await this.manager.rollover(sourceJobId, input, { automatic: false });
      if (!JOB.test(created?.id)) throw new Error('Workflow submission returned invalid child');
      stage.jobId = created.id;
      await writeStore(file, store);
      return publicStatus(store);
    });
  }
  async deliverCancel(store, file) {
    if (!store.cancelIntent) return;
    if (!store.cancelIntent.jobId && store.cancelIntent.requestId) {
      const found = await this.manager.lock(async () => {
        const child = (await this.manager.all()).find(job => job.requestId === store.cancelIntent.requestId);
        if (!child) return null;
        const stage = store.stages.find(item => item.intent?.requestId === store.cancelIntent.requestId);
        if (!stage) throw new Error('Workflow request ID points to a different child');
        const source = stage.intent.sourceJobId ? await freshJob(this.manager, await this.manager.read(stage.intent.sourceJobId)) : null;
        if (!await existingMatches(this.manager, stage, child, source)) throw new Error('Workflow request ID points to a different child');
        validatePreparedSource(stage, stage.intent.sourceJobId, source);
        return child;
      });
      if (found) {
        const stage = store.stages.find(item => item.intent?.requestId === store.cancelIntent.requestId);
        store.cancelIntent.jobId = found.id;
        stage.jobId = found.id;
        await writeStore(file, store);
      }
    }
    const target = store.cancelIntent.jobId;
    if (!target) return;
    await this.manager.cancel(target);
    store.cancelIntent.deliveredAt = now();
    await writeStore(file, store);
  }
  async cancel(id) {
    return this.withGoal(id, async () => {
      const file = this.file(id); const store = await readSafe(file);
      if (store.released) throw new Error('Workflow released');
      store.cancelRequested = true;
      const stage = store.stages[store.index];
      if (!store.cancelIntent) store.cancelIntent = { jobId: stage?.jobId ?? null, requestId: stage?.intent?.requestId ?? null, at: now() };
      await writeStore(file, store);
      await this.deliverCancel(store, file);
      await this.countTerminalCancellationUsage(store, file);
      return publicStatus(store);
    });
  }
  async release(id) {
    return this.withGoal(id, async () => {
      const file = this.file(id); const store = await readSafe(file);
      if (store.released) return publicStatus(store);
      if (!store.cancelRequested && (store.index !== store.stages.length || store.blockedReason)) throw new Error('Workflow must complete or be cancelled before release');
      await this.manager.lock(async () => {
        for (const stage of store.stages) if (stage.jobId && !TERMINAL.has((await this.manager.read(stage.jobId)).status)) throw new Error('Active workflow child cannot be released');
        for (const stage of store.stages) if (stage.intent && !stage.jobId) {
          const found = (await this.manager.all()).find(job => job.requestId === stage.intent.requestId);
          if (found && !TERMINAL.has(found.status)) throw new Error('Active workflow child cannot be released');
        }
        if (!store.cancelRequested) {
          const last = store.stages.at(-1);
          const final = last.jobId ? await freshJob(this.manager, await this.manager.read(last.jobId)) : null;
          const sourceId = last.kind === 'review' ? sourceFor(store) : null;
          const source = sourceId ? await freshJob(this.manager, await this.manager.read(sourceId)) : null;
          if (finalAcceptanceGate(final) || source && finalAcceptanceGate(source)) throw new Error('Workflow final acceptance was revoked');
        }
        if (store.cancelRequested) await this.countTerminalCancellationUsageUnderLock(store);
        store.released = true;
        await writeStore(file, store);
      });
      return publicStatus(store);
    });
  }
  async countTerminalCancellationUsage(store, file) {
    await this.manager.lock(async () => {
      await this.countTerminalCancellationUsageUnderLock(store);
      await writeStore(file, store);
    });
  }
  async countTerminalCancellationUsageUnderLock(store) {
    for (const stage of store.stages) {
      let job = stage.jobId ? await this.manager.read(stage.jobId) : null;
      if (!job && stage.intent) job = (await this.manager.all()).find(candidate => candidate.requestId === stage.intent.requestId);
      if (!job) continue;
      if (stage.intent) {
        const source = stage.intent.sourceJobId ? await freshJob(this.manager, await this.manager.read(stage.intent.sourceJobId)) : null;
        if (!await existingMatches(this.manager, stage, job, source)) throw new Error('Workflow request ID points to a different child');
        validatePreparedSource(stage, stage.intent.sourceJobId, source);
      }
      if (TERMINAL.has(job.status)) countedUsage(store, await freshJob(this.manager, job));
    }
  }
}
