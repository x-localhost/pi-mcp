#!/usr/bin/env node
// replay/compare remain offline: Manager and config are imported only by live.
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as C } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SchemaError } from '../evals/errors.mjs';
import { parseTraceBatch } from '../evals/schema.mjs';
import { loadSuite } from '../evals/suite.mjs';
import { GRADER_VERSION } from '../evals/grader.mjs';
import { buildReport, writeReport } from '../evals/report.mjs';
import { compareReports } from '../evals/compare.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
const MAX_INPUT = 5 * 1024 * 1024;
const ACK = 'I-UNDERSTAND-THIS-SUBMITS-TO-THE-CONFIGURED-PI-MCP-MANAGER';
const legal = {
  replay: new Set(['fixture','traces','origin','select','harness-commit','task-base-commit','config-fingerprint','out']),
  compare: new Set(['baseline','candidate','allow-selection-mismatch','allow-observed-mismatch','out']),
  live: new Set(['live','ack','run-id','select','repository','base-commit','state-dir','config','provider','model','poll-timeout-ms','run-timeout-ms','out']),
};
const booleans = new Set(['live','allow-selection-mismatch','allow-observed-mismatch']);
function parseArgs(argv) {
  const [subcommand,...rest] = argv;
  if (!legal[subcommand]) throw new Error('Expected replay, compare or live');
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i], name = token?.slice(2);
    if (!token?.startsWith('--') || !legal[subcommand].has(name)) throw new Error('Unknown or positional argument');
    if (Object.hasOwn(flags,name)) throw new Error('Duplicate flag: --' + name);
    if (booleans.has(name)) { flags[name] = true; continue; }
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error('Missing value for --' + name);
    flags[name] = value;
  }
  return { subcommand, flags };
}
async function readJson(file) {
  if (typeof file !== 'string') throw new Error('Input file required');
  const h = await fs.open(path.resolve(file), C.O_RDONLY | C.O_NOFOLLOW).catch(() => { throw new SchemaError('Unable to read input'); });
  try {
    const before = await h.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > MAX_INPUT) throw new SchemaError('Unsafe or oversized input');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await h.read(bytes, offset, bytes.length-offset, offset);
      if (!bytesRead) throw new SchemaError('Input changed during read');
      offset += bytesRead;
    }
    const after = await h.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new SchemaError('Input changed during read');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await h.close(); }
}
function selection(raw, suite) {
  if (typeof raw !== 'string') throw new Error('--select required');
  const ids = raw.split(',');
  if (!ids.length || ids.length > 16 || ids.some(id => !id || id !== id.trim()) ||
    new Set(ids).size !== ids.length || ids.some(id => !suite.tasks.some(task => task.id === id))) throw new Error('Invalid selected task IDs');
  return ids;
}
function boundedMs(raw, label, defaultValue, max) {
  if (raw === undefined) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error('Invalid ' + label);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw new Error('Invalid ' + label);
  return value;
}
async function tracesFor(flags) {
  if (flags.fixture && flags.traces) throw new Error('Choose fixture or traces');
  if (flags.fixture) {
    if (!['baseline','regressed','incomplete'].includes(flags.fixture)) throw new Error('Unknown fixture');
    const module = await import(pathToFileURL(path.join(root,'evals','fixtures','synthetic-'+flags.fixture+'.mjs')));
    return module.traces;
  }
  const value = await readJson(flags.traces);
  return Array.isArray(value) ? value : value?.version === 1 && Array.isArray(value.traces) ? value.traces : value;
}
async function emit(flags, value) {
  if (flags.out) {
    const destination = path.resolve(flags.out);
    await writeReport(destination,value);
    process.stdout.write('Wrote output to ' + destination + '\n');
  } else process.stdout.write(JSON.stringify(value,null,2) + '\n');
}
async function replay(flags) {
  for (const name of ['harness-commit','task-base-commit','config-fingerprint']) if (typeof flags[name] !== 'string') throw new Error('Missing --'+name);
  const suite = await loadSuite();
  const traces = parseTraceBatch(await tracesFor(flags));
  const origin = flags.fixture ? 'synthetic' : flags.origin ?? 'synthetic';
  const selectedTaskIds = flags.select ? selection(flags.select,suite) : suite.tasks.map(task => task.id);
  await emit(flags, buildReport({ suite, graderVersion: GRADER_VERSION, selectedTaskIds,
    harnessCommit: flags['harness-commit'], taskBaseCommit: flags['task-base-commit'],
    configFingerprint: flags['config-fingerprint'], origin, traces }));
}
async function compare(flags) {
  if (!flags.baseline || !flags.candidate) throw new Error('compare requires baseline and candidate');
  await emit(flags, compareReports(await readJson(flags.baseline), await readJson(flags.candidate),
    { allowSelectionMismatch: !!flags['allow-selection-mismatch'], allowObservedMismatch: !!flags['allow-observed-mismatch'] }));
}
async function live(flags) {
  if (!flags.live) throw new Error('live requires --live');
  if (flags.ack !== ACK) throw new Error('live requires --ack ' + ACK);
  for (const key of ['run-id','select','repository','base-commit','state-dir']) if (typeof flags[key] !== 'string') throw new Error('live requires --' + key);
  const suite = await loadSuite();
  const selectedTaskIds = selection(flags.select,suite);
  const pollMs = boundedMs(flags['poll-timeout-ms'],'poll-timeout-ms',30000,30000);
  const runMs = boundedMs(flags['run-timeout-ms'],'run-timeout-ms',120000,120000);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(flags['run-id'])) throw new Error('Invalid run-id');
  if (flags.provider && !/^[a-zA-Z0-9_-]{1,80}$/.test(flags.provider) ||
      flags.model && !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(flags.model)) throw new Error('Invalid provider/model ID');
  const repository = path.resolve(flags.repository), stateDir = path.resolve(flags['state-dir']);
  const { stdout } = await exec('git',['-C',root,'rev-parse','HEAD'],{timeout:5000,maxBuffer:1024});
  const harnessCommit = stdout.trim();
  const checkout = await exec('git',['-C',root,'rev-parse','--show-toplevel'],{timeout:5000,maxBuffer:1024});
  if (path.resolve(checkout.stdout.trim()) !== root) throw new Error('Evaluation source checkout unavailable');
  const dirty = await exec('git',['-C',root,'status','--porcelain=v1','--untracked-files=all','--',
    'src/','internal-agent/','evals/','scripts/','package.json','package-lock.json'],{timeout:5000,maxBuffer:4096});
  if (dirty.stdout.length) throw new Error('Evaluation source checkout is dirty');
  // No Manager/config side effects occur before selection, time, and SHA validation.
  if (!/^[0-9a-f]{40}$/.test(harnessCommit) || !/^[0-9a-f]{40}$/.test(flags['base-commit'])) throw new Error('Committed SHAs required');
  const base = await exec('git',['-C',repository,'rev-parse','--verify',flags['base-commit']+'^{commit}'],{timeout:5000,maxBuffer:1024})
    .catch(() => { throw new Error('Task base commit unavailable'); });
  if (base.stdout.trim() !== flags['base-commit']) throw new Error('Task base commit unavailable');
  const { loadConfig, buildChildEnv } = await import('../src/config.mjs');
  const { Manager } = await import('../src/manager.mjs');
  const { submitLiveRun, pollLiveRun } = await import('../evals/live-adapter.mjs');
  let config, manager;
  try {
    config = await loadConfig(flags.config || process.env.PI_MCP_CONFIG);
    manager = await new Manager(config, buildChildEnv(config)).init();
  } catch { throw new Error('Live Manager initialization failed'); }
  const selected = selectedTaskIds.map(id => suite.tasks.find(task => task.id === id));
  const deadline = Date.now() + runMs, traces = [];
  for (const task of selected) {
    if (Date.now() >= deadline) break;
    const submission = await submitLiveRun({ manager,stateDir,runId:flags['run-id'],suiteDigest:suite.digest,
      selectedTaskIds,tasks:selected,task,repository,baseCommit:flags['base-commit'],
      harnessCommit,config,provider:flags.provider,model:flags.model,acknowledgeLive:true }).catch(() => { throw new Error('Live submission failed'); });
    const polled = await pollLiveRun({ manager,jobId:submission.jobId,timeoutMs:Math.min(pollMs,Math.max(0,deadline-Date.now())),
      task,submission,runId:flags['run-id'],harnessCommit,taskBaseCommit:flags['base-commit'] }).catch(() => { throw new Error('Live evidence collection failed'); });
    traces.push(polled.trace);
  }
  const report = buildReport({ suite,graderVersion:GRADER_VERSION,selectedTaskIds,harnessCommit,
    taskBaseCommit:flags['base-commit'],configFingerprint:traces[0]?.configFingerprint ??
      (await import('../evals/live-adapter.mjs')).effectiveConfigFingerprint(config,flags.provider,flags.model),
    origin:'live',traces });
  await emit(flags,{ version:1,origin:'live',runId:flags['run-id'],traces,report });
}
async function main() {
  const { subcommand, flags } = parseArgs(process.argv.slice(2));
  return ({ replay,compare,live })[subcommand](flags);
}
main().catch(error => {
  const message = error instanceof SchemaError || error instanceof SyntaxError ? 'Invalid evaluation input' :
    error?.name === 'ProvenanceError' ? 'Incompatible evaluation provenance' :
    ['Error'].includes(error?.name) && typeof error.message === 'string' && error.message.length <= 120 &&
      /^(Expected replay, compare or live|Unknown or positional argument|Duplicate flag: --[a-z-]+|Missing value for --[a-z-]+|live requires --live|live requires --ack live-execution|Live Manager initialization failed|Live submission failed|Live evidence collection failed)$/.test(error.message)
      ? error.message : 'Evaluation command failed';
  process.stderr.write((error?.name === 'SchemaError' ? 'SchemaError' : error?.name === 'ProvenanceError' ? 'ProvenanceError' : 'Error') + ': ' + message + '\n');
  process.exitCode = error.name === 'SchemaError' ? 2 : error.name === 'ProvenanceError' ? 3 : 1;
});
