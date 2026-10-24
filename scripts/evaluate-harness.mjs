#!/usr/bin/env node
// Offline-first harness evaluation CLI. See docs/harness-evals.md for the
// full command reference.
//
// `replay` and `compare` are fully offline: this file's only static imports
// are the pure evals/* offline modules below. Manager, pi-mcp configuration
// and any live adapter code are imported dynamically, and only inside the
// `live` subcommand, and only after the explicit --live/--ack guard passes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SchemaError } from '../evals/errors.mjs';
import { parseTraceBatch } from '../evals/schema.mjs';
import { loadSuite } from '../evals/suite.mjs';
import { gradeSuite } from '../evals/grader.mjs';
import { buildReport, writeReport } from '../evals/report.mjs';
import { compareReports } from '../evals/compare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const LIVE_ACK_TOKEN = 'I-UNDERSTAND-THIS-SUBMITS-TO-THE-CONFIGURED-PI-MCP-MANAGER';

function parseArgs(argv) {
  const [subcommand, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else { flags[name] = next; i++; }
  }
  return { subcommand, flags };
}

async function readBoundedJson(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new SchemaError(`Input file too large or not a regular file: ${file}`);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function loadTraces(flags) {
  if (flags.fixture) {
    if (!['baseline', 'regressed'].includes(flags.fixture)) throw new Error('--fixture must be "baseline" or "regressed"');
    const module = await import(pathToFileURL(path.join(repoRoot, 'evals', 'fixtures', `synthetic-${flags.fixture}.mjs`)));
    return module.traces;
  }
  if (flags.traces) return await readBoundedJson(path.isAbsolute(flags.traces) ? flags.traces : path.resolve(process.cwd(), flags.traces));
  throw new Error('replay requires --fixture <baseline|regressed> or --traces <path>');
}

async function emit(flags, report) {
  if (flags.out) {
    const destination = path.isAbsolute(flags.out) ? flags.out : path.resolve(process.cwd(), flags.out);
    await writeReport(destination, report);
    process.stdout.write(`Wrote report to ${destination}\n`);
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
}

async function runReplay(flags) {
  const required = ['harness-commit', 'task-base-commit', 'config-fingerprint'];
  for (const name of required) if (typeof flags[name] !== 'string') throw new Error(`replay requires --${name}`);
  const origin = flags.fixture ? 'synthetic' : (flags.origin || 'synthetic');
  const suite = await loadSuite();
  const rawTraces = await loadTraces(flags);
  const traces = parseTraceBatch(rawTraces);
  const selectedTaskIds = flags.select ? String(flags.select).split(',').map(id => id.trim()).filter(Boolean) : suite.tasks.map(task => task.id);
  const result = gradeSuite({ suite, traces, selectedTaskIds });
  const report = buildReport({
    suite, graderVersion: result.graderVersion, selectedTaskIds,
    harnessCommit: flags['harness-commit'], taskBaseCommit: flags['task-base-commit'],
    configFingerprint: flags['config-fingerprint'], origin, traces, result,
  });
  await emit(flags, report);
}

async function runCompare(flags) {
  if (typeof flags.baseline !== 'string' || typeof flags.candidate !== 'string') throw new Error('compare requires --baseline <path> and --candidate <path>');
  const baseline = await readBoundedJson(path.resolve(process.cwd(), flags.baseline));
  const candidate = await readBoundedJson(path.resolve(process.cwd(), flags.candidate));
  const comparison = compareReports(baseline, candidate, { allowSelectionMismatch: Boolean(flags['allow-selection-mismatch']) });
  await emit(flags, comparison);
}

async function runLive(flags) {
  // Guard first: no config, credentials, Manager or live-adapter module is
  // touched until both conditions below hold.
  if (!flags.live) throw new Error('live requires --live to explicitly opt in to contacting the configured Pi MCP Manager');
  if (flags.ack !== LIVE_ACK_TOKEN) throw new Error(`live requires --ack ${LIVE_ACK_TOKEN}`);
  for (const name of ['run-id', 'select', 'repository', 'base-commit', 'config-fingerprint', 'state-dir']) {
    if (typeof flags[name] !== 'string') throw new Error(`live requires --${name}`);
  }

  const { submitLiveRun, pollLiveRun } = await import('../evals/live-adapter.mjs');
  const { loadConfig, buildChildEnv } = await import('../src/config.mjs');
  const { Manager } = await import('../src/manager.mjs');

  const config = await loadConfig(flags.config || process.env.PI_MCP_CONFIG);
  const childEnv = buildChildEnv(config);
  const manager = await new Manager(config, childEnv).init();

  const suite = await loadSuite();
  const selectedTaskIds = String(flags.select).split(',').map(id => id.trim()).filter(Boolean);
  const results = [];
  for (const taskId of selectedTaskIds) {
    const task = suite.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Unknown task id in --select: ${taskId}`);
    const submitted = await submitLiveRun({
      manager, stateDir: path.resolve(process.cwd(), flags['state-dir']), runId: flags['run-id'],
      suiteDigest: suite.digest, selectedTaskIds, task,
      repository: path.resolve(process.cwd(), flags.repository), baseCommit: flags['base-commit'],
      configFingerprint: flags['config-fingerprint'], provider: flags.provider, model: flags.model,
      acknowledgeLive: true,
    });
    const polled = await pollLiveRun({ manager, jobId: submitted.jobId, timeoutMs: Number(flags['poll-timeout-ms']) || 30000 });
    results.push({ ...submitted, status: polled.status, finishedAt: polled.finishedAt, error: polled.error });
  }
  await emit(flags, { origin: 'live', runId: flags['run-id'], results });
}

async function main() {
  const { subcommand, flags } = parseArgs(process.argv.slice(2));
  if (subcommand === 'replay') return runReplay(flags);
  if (subcommand === 'compare') return runCompare(flags);
  if (subcommand === 'live') return runLive(flags);
  throw new Error('Usage: evaluate-harness.mjs <replay|compare|live> [--flags]');
}

main().catch(error => {
  process.stderr.write(`${error.name || 'Error'}: ${error.message}\n`);
  process.exitCode = error.name === 'SchemaError' ? 2 : error.name === 'ProvenanceError' ? 3 : 1;
});
