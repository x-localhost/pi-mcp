import fs from 'node:fs/promises';
import path from 'node:path';
import { gradeSuite, GRADER_VERSION } from './grader.mjs';
import { parseTask, parseTraceBatch } from './schema.mjs';
import { sha256Hex, stableStringify, GIT_SHA, HEX64, CONFIG_FINGERPRINT_PATTERN } from './util.mjs';
import { ProvenanceError } from './errors.mjs';

export const REPORT_LIMIT = 2 * 1024 * 1024;
const origins = new Set(['synthetic','live']);
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key));
function boundedText(value, pattern) { return typeof value === 'string' && value.length <= 2000 && pattern.test(value); }
export function buildReport({ suite, graderVersion, selectedTaskIds, harnessCommit, taskBaseCommit, configFingerprint, origin, traces }) {
  if (!suite || suite.version !== 'v1' || !Array.isArray(suite.tasks) || suite.tasks.length < 1 || suite.tasks.length > 16 ||
    !HEX64.test(suite.digest || '') || suite.digest !== sha256Hex(stableStringify(suite.tasks.map(parseTask)))) throw new Error('Invalid complete suite digest');
  if (graderVersion !== GRADER_VERSION || !boundedText(harnessCommit, GIT_SHA) || !boundedText(taskBaseCommit, GIT_SHA) ||
    !boundedText(configFingerprint, CONFIG_FINGERPRINT_PATTERN) || !origins.has(origin)) throw new Error('Invalid report provenance');
  const parsed = parseTraceBatch(traces);
  for (const trace of parsed) {
    if (trace.origin !== origin || trace.harnessCommit !== harnessCommit || trace.taskBaseCommit !== taskBaseCommit ||
      trace.configFingerprint !== configFingerprint) throw new ProvenanceError('Trace provenance does not match report');
  }
  const result = gradeSuite({ suite, traces: parsed, selectedTaskIds });
  return { reportVersion: 'v1', suiteVersion: suite.version, suiteDigest: suite.digest, graderVersion,
    origin, harnessCommit, taskBaseCommit, configFingerprint, selectedTaskIds: [...selectedTaskIds],
    observedTaskIds: parsed.map(item => item.taskId), result,
    ...(origin === 'synthetic' ? { note: 'Synthetic replay validates grader consistency only; it does not measure model capability.' } : {}) };
}
export function validateReport(raw) {
  if (!keys(raw, ['reportVersion','suiteVersion','suiteDigest','graderVersion','origin','harnessCommit','taskBaseCommit','configFingerprint',
    'selectedTaskIds','observedTaskIds','result','note']) || raw.reportVersion !== 'v1' || raw.suiteVersion !== 'v1' ||
    raw.graderVersion !== GRADER_VERSION || !HEX64.test(raw.suiteDigest || '') || !origins.has(raw.origin) ||
    !boundedText(raw.harnessCommit, GIT_SHA) || !boundedText(raw.taskBaseCommit, GIT_SHA) ||
    !boundedText(raw.configFingerprint, CONFIG_FINGERPRINT_PATTERN)) throw new Error('Invalid report');
  const ids = raw.selectedTaskIds, observed = raw.observedTaskIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 || new Set(ids).size !== ids.length ||
    ids.some(id => !/^[a-z][a-z0-9-]{2,63}$/.test(id)) || !Array.isArray(observed) ||
    new Set(observed).size !== observed.length || observed.some(id => !ids.includes(id))) throw new Error('Invalid report coverage');
  const result = raw.result;
  if (!keys(result, ['graderVersion','selectedTaskIds','taskSuccess','constraintRetention','resumeCorrectness','latencyMs','usage','perTask']) ||
    result.graderVersion !== GRADER_VERSION || JSON.stringify(result.selectedTaskIds) !== JSON.stringify(ids) ||
    !Array.isArray(result.perTask) || result.perTask.length !== ids.length) throw new Error('Invalid report result');
  for (let i = 0; i < ids.length; i++) {
    const item = result.perTask[i];
    if (!keys(item, ['taskId','criteria','taskSuccess','reason','constraintRetention','resumeCorrectness','latencyMs','usage','hasTrace']) ||
      item.taskId !== ids[i] || item.hasTrace !== observed.includes(ids[i]) || typeof item.taskSuccess !== 'boolean' ||
      !Array.isArray(item.criteria) || item.criteria.length > 16 || item.criteria.some(c => !keys(c, ['id','kind','description','outcome','reason']) ||
        !['pass','fail','unknown'].includes(c.outcome) || !['artifact','verification','review','resume','constraint'].includes(c.kind) ||
        typeof c.id !== 'string' || c.id.length > 100 || typeof c.description !== 'string' || c.description.length > 1000) ||
      item.latencyMs !== null && (!Number.isFinite(item.latencyMs) || item.latencyMs < 0) ||
      !keys(item.usage, ['totalTokens','costUsd','observedResponses']) ||
      !Number.isInteger(item.usage.observedResponses) || item.usage.observedResponses < 0 ||
      ['totalTokens','costUsd'].some(key => item.usage[key] !== null && (!Number.isFinite(item.usage[key]) || item.usage[key] < 0)))
      throw new Error('Invalid per-task report result');
  }
  if (!keys(result.taskSuccess, ['passed','total','rate']) || result.taskSuccess.total !== ids.length ||
    result.taskSuccess.passed !== result.perTask.filter(item => item.taskSuccess).length ||
    result.taskSuccess.rate !== result.taskSuccess.passed / ids.length) throw new Error('Invalid task success aggregate');
  for (const name of ['constraintRetention','resumeCorrectness']) {
    const section = result[name], labels = name === 'constraintRetention' ? ['retained','lost','unknown'] : ['correct','incorrect','unknown'];
    if (!keys(section, [...labels,'applicable']) || !Number.isInteger(section.applicable) ||
      labels.some(label => !Number.isInteger(section[label]) || section[label] < 0) ||
      labels.reduce((n,label) => n + section[label],0) !== section.applicable) throw new Error('Invalid categorical aggregate');
  }
  for (const section of [result.latencyMs,result.usage?.totalTokens,result.usage?.costUsd]) {
    if (!keys(section, ['value','observedCount','applicableCount','unknownCount']) ||
      section.applicableCount !== ids.length || !Number.isInteger(section.observedCount) || section.observedCount < 0 ||
      section.unknownCount !== ids.length - section.observedCount ||
      section.value !== null && (!Number.isFinite(section.value) || section.value < 0)) throw new Error('Invalid measured aggregate');
  }
  if (raw.origin === 'synthetic' ? typeof raw.note !== 'string' || raw.note.length > 200 : raw.note !== undefined) throw new Error('Invalid report note');
  if (Buffer.byteLength(JSON.stringify(raw)) > REPORT_LIMIT) throw new Error('Report too large');
  return raw;
}
export async function writeReport(destination, report) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('Absolute report destination required');
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  if (bytes.length > REPORT_LIMIT) throw new Error('Report too large');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const h = await fs.open(destination, 'wx', 0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
}
