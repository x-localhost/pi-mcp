import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitize } from './sanitize.mjs';

const exec = promisify(execFile);
const codeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const active = new Set(['starting', 'running', 'quarantined']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'turn_limit', 'interrupted']);
const idPattern = /^task-[0-9a-f-]{36}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

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
  if (Array.isArray(value)) return value.forEach(rejectCommands);
  if (typeof value === 'string' && /^!/.test(value.trim()) && /(?:apiKey|headers?|credential|token|secret)/i.test(keyName)) throw new Error('Command-bearing credential value is unsupported');
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
    for (const dir of [this.config.stateDir, this.jobsDir, this.worktreesDir, this.agentDir]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700);
    }
    return this;
  }
  jobDir(id) { assertId(id); return path.join(this.jobsDir, id); }
  async read(id) { return JSON.parse(await fs.readFile(path.join(this.jobDir(id), 'job.json'), 'utf8')); }
  async lock(run) {
    const lock = path.join(this.config.stateDir, 'submit.lock'); let held = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.mkdir(lock, { mode: 0o700 }); held = true; await fs.writeFile(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(await fs.readFile(path.join(lock, 'pid'), 'utf8').catch(() => '0'));
        const stat = await fs.stat(lock).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 5000 && (!owner || !alive(owner))) await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
        await sleep(100);
      }
    }
    if (!held) throw new Error('Submission lock busy');
    try { return await run(); } finally { await fs.rm(lock, { recursive: true, force: true }); }
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
    // A worker may have saved a final snapshot after this caller read a running one.
    const latest = await this.read(job.id);
    if (terminal.has(latest.status) || latest.status === 'quarantined') return latest;
    // A persisted numeric PID alone does not prove process identity after worker death.
    // Retain the concurrency slot until an operator verifies the orphaned process group.
    const ended = { ...latest, status: 'quarantined', error: 'Worker stopped; process-group cleanup cannot be verified safely', finishedAt: now() };
    await atomicJson(path.join(this.jobDir(job.id), 'job.json'), ended); return ended;
  }
  async all() {
    const ids = (await fs.readdir(this.jobsDir)).filter(id => idPattern.test(id));
    const jobs = await Promise.all(ids.map(async id => {
      const job = await this.read(id);
      const marker = Number(await fs.readFile(path.join(this.jobDir(id), 'worker.pid'), 'utf8').catch(() => '0'));
      const pid = job.workerPid || marker;
      if (['starting', 'running'].includes(job.status) && pid && !alive(pid)) return this.recover(job);
      if (job.status === 'starting' && !pid && Date.now() - Date.parse(job.createdAt) > 15000) return this.recover(job);
      return job;
    }));
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  public(job) {
    const keys = ['id', 'title', 'status', 'repository', 'worktree', 'branch', 'baseCommit', 'parentJobId', 'createdAt', 'startedAt', 'finishedAt', 'heartbeatAt', 'sessionFile', 'sessionId', 'effectiveModel', 'lastProgress', 'error', 'warning', 'exitCode', 'numTurns', 'usage', 'permissionDenials', 'diffStat', 'changedFiles'];
    return sanitize(Object.fromEntries(keys.filter(key => job[key] !== undefined).map(key => [key, job[key]])), this.childEnv);
  }
  async seedAgent() {
    for (const [explicit, name] of [[this.config.modelsFile, 'models.json'], [this.config.authFile, 'auth.json']]) {
      const source = explicit || (this.config.agentDir && await fs.stat(path.join(this.config.agentDir, name)).then(() => true, () => false) ? path.join(this.config.agentDir, name) : null);
      if (!source) continue;
      const target = path.join(this.agentDir, name);
      rejectCommands(JSON.parse(await fs.readFile(source, 'utf8')));
      const existing = await fs.stat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (existing) {
        if (name === 'models.json' && sha(await fs.readFile(source)) !== sha(await fs.readFile(target))) throw new Error('models.json changed; explicit pi-mcp agent reset required after jobs stop');
        continue;
      }
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL); await fs.chmod(target, 0o600);
    }
  }
  async start(input, parentId) {
    return this.lock(async () => {
      const jobs = await this.all(); const parent = parentId ? jobs.find(job => job.id === parentId) : null;
      if (parentId && !parent) throw new Error('Job not found');
      if (parent && !terminal.has(parent.status)) throw new Error('Parent job is not terminal');
      const repository = await this.repository(parent?.repository || input.repository);
      required(input.prompt, 'prompt', 100000); if (!parent) required(input.title, 'title', 150);
      if (input.request_id !== undefined) required(input.request_id, 'request_id', 100);
      const mode = parent?.mode || input.mode || 'implement';
      if (!['implement', 'review'].includes(mode) || (parent && input.mode && input.mode !== mode)) throw new Error('Invalid mode');
      if (!parent && Boolean(input.provider) !== Boolean(input.model)) throw new Error('provider and model overrides must be supplied together');
      const provider = parent?.provider || input.provider || this.config.provider;
      const model = parent?.model || input.model || this.config.model;
      if (!provider || !model) throw new Error('provider and model must be configured or supplied');
      const requestHash = sha(stable({ ...input, repository, parentId: parentId || null }));
      if (input.request_id) {
        const existing = jobs.find(job => job.requestId === input.request_id);
        if (existing) {
          if (existing.requestHash !== requestHash) throw new Error('request_id already used with different inputs');
          return this.public(existing);
        }
      }
      if (jobs.filter(job => active.has(job.status)).length >= this.config.maxConcurrent) throw new Error('Concurrency limit reached');
      if (parent && jobs.some(job => active.has(job.status) && job.worktree === parent.worktree)) throw new Error('Worktree already active');
      const timeoutSeconds = input.timeout_seconds ?? this.config.defaultTimeoutSeconds;
      const maxTurns = input.max_turns ?? this.config.defaultMaxTurns;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > this.config.maxTimeoutSeconds) throw new Error('Invalid timeout_seconds');
      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new Error('Invalid max_turns');
      const ref = input.base_ref || 'HEAD';
      if (!parent && (typeof ref !== 'string' || ref.startsWith('-') || /[\0\r\n]/.test(ref))) throw new Error('Invalid base_ref');
      const baseCommit = parent?.baseCommit || await git(repository, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], false, this.childEnv);
      const id = `task-${randomUUID()}`; const dir = this.jobDir(id);
      const worktree = parent?.worktree || path.join(this.worktreesDir, id);
      const branch = parent?.branch || `codex/pi/${id.slice(5)}`;
      const dirty = !parent && !!await git(repository, ['status', '--porcelain', '--untracked-files=all'], false, this.childEnv);
      if (parent && (!parent.sessionFile || !await fs.stat(parent.sessionFile).catch(() => null))) throw new Error('Parent session unavailable');
      if (parent) {
        const actualWorktree = await fs.realpath(parent.worktree);
        if (actualWorktree !== parent.worktree || actualWorktree !== await fs.realpath(await git(actualWorktree, ['rev-parse', '--show-toplevel'], false, this.childEnv))) throw new Error('Parent worktree changed');
        if (await git(actualWorktree, ['branch', '--show-current'], false, this.childEnv) !== parent.branch) throw new Error('Parent branch changed');
      }
      const sessionDir = parent?.sessionDir || path.join(this.config.stateDir, 'sessions', id);
      const job = { id, title: parent?.title || input.title, repository, worktree, branch, baseCommit, prompt: input.prompt,
        mode, provider, model, thinkingLevel: parent?.thinkingLevel || input.thinking_level || this.config.thinkingLevel,
        timeoutSeconds, maxTurns, requestId: input.request_id, requestHash, parentJobId: parentId || undefined,
        sessionDir, sessionFile: parent?.sessionFile, status: 'starting', createdAt: now(),
        ...(dirty ? { warning: 'Source has uncommitted changes; only selected commit is present in worktree.' } : {}) };
      await fs.mkdir(dir, { mode: 0o700 }); await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
      await atomicJson(path.join(dir, 'job.json'), job);
      try {
        if (!parent) await git(repository, ['worktree', 'add', '-b', branch, worktree, baseCommit], false, this.childEnv);
        await this.seedAgent();
        await atomicJson(path.join(dir, 'runtime.json'), { piPath: this.config.piPath, piArgs: this.config.piArgs || [],
          agentDir: this.agentDir, allowedCommands: this.config.allowedCommands || [], policyExtension: path.join(codeRoot, 'src', 'policy-extension.mjs') });
        if (this.spawnWorker) {
          const child = spawn(process.execPath, [path.join(codeRoot, 'src', 'worker.mjs'), dir], {
            cwd: codeRoot, detached: true, stdio: 'ignore', env: { ...this.childEnv, PI_CODING_AGENT_DIR: this.agentDir }
          });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          child.unref(); await fs.writeFile(path.join(dir, 'worker.pid'), String(child.pid), { mode: 0o600 });
        }
        return { ...this.public(job), artifactsDir: dir };
      } catch (error) {
        await atomicJson(path.join(dir, 'job.json'), { ...job, status: 'failed', error: error.message, finishedAt: now() });
        throw error;
      }
    });
  }
  async status(id, waitSeconds = 0) {
    assertId(id); const until = Date.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), 45) * 1000;
    while (true) {
      const job = await this.read(id);
      const marker = Number(await fs.readFile(path.join(this.jobDir(id), 'worker.pid'), 'utf8').catch(() => '0'));
      const pid = job.workerPid || marker;
      const current = ['starting', 'running'].includes(job.status) && pid && !alive(pid) ? await this.recover(job)
        : job.status === 'starting' && !pid && Date.now() - Date.parse(job.createdAt) > 15000 ? await this.recover(job) : job;
      if (!active.has(current.status) || Date.now() >= until) return this.public(current);
      await sleep(400);
    }
  }
  async result(id) {
    const job = await this.status(id); const dir = this.jobDir(id);
    const tail = async (name, max) => {
      const handle = await fs.open(path.join(dir, name), 'r').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!handle) return '';
      try { const stat = await handle.stat(); const buf = Buffer.alloc(Math.min(max, stat.size)); await handle.read(buf, 0, buf.length, stat.size - buf.length); return sanitize(buf.toString('utf8'), this.childEnv); }
      finally { await handle.close(); }
    };
    return { ...job, result: await tail('result.txt', 24000), stderrTail: await tail('stderr.log', 4000), diffPreview: await tail('changes.patch', 24000), artifactsDir: dir,
      untrackedNote: 'Patch contains tracked changes only; inspect changedFiles and preserved worktree for new files.' };
  }
  async cancel(id) {
    const job = await this.status(id); if (!active.has(job.status)) return job;
    await fs.writeFile(path.join(this.jobDir(id), 'cancel'), now(), { mode: 0o600 });
    return { ...job, cancellationRequested: true };
  }
  async health() {
    const version = (await exec(this.config.piPath, [...(this.config.piArgs || []), '--version'], { env: this.childEnv, timeout: 10000 })).stdout.trim();
    if (!/\b1\.4\.0\b/.test(version)) throw new Error(`Unsupported Pi version: ${version}`);
    const which = async name => { for (const dir of (this.childEnv.PATH || '').split(path.delimiter)) if (await fs.access(path.join(dir, name), fs.constants.X_OK).then(() => true, () => false)) return true; return false; };
    return { version, allowedRoots: this.config.allowedRoots, stateDir: this.config.stateDir, maxConcurrent: this.config.maxConcurrent,
      activeJobs: (await this.all()).filter(job => active.has(job.status)).length,
      authenticationPresent: !!await fs.stat(path.join(this.agentDir, 'auth.json')).catch(() => null) || !!this.config.authFile || !!this.config.envAllowlist?.some(key => /KEY|TOKEN/i.test(key) && this.childEnv[key]),
      authenticationNote: 'Credential presence does not prove authentication.', requiredTools: { rg: await which('rg'), fd: await which('fd') } };
  }
}
