import fs from 'node:fs/promises';
import path from 'node:path';
import { gradeSuite, GRADER_VERSION } from './grader.mjs';
import { parseTask, parseTraceBatch } from './schema.mjs';
import { sha256Hex, stableStringify, GIT_SHA, HEX64, CONFIG_FINGERPRINT_PATTERN } from './util.mjs';
import { ProvenanceError } from './errors.mjs';

export const REPORT_LIMIT = 2 * 1024 * 1024;
const origins = new Set(['synthetic','live']);
const reasons = new Set([null,'execution_incomplete','execution_failed','evidence_unavailable','missing_evidence',
  'required_artifact_absent','wrong_job','stale_evidence','contract_mismatch','missing_verifier',
  'verification_failed','review_rejected','event_gap','duplicate_job']);
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key));
function boundedText(value, pattern) { return typeof value === 'string' && value.length <= 2000 && pattern.test(value); }
function same(a,b) { return stableStringify(a) === stableStringify(b); }
function aggregate(values) {
  const observed = values.filter(value => value !== null);
  return { value: observed.length ? observed.reduce((sum,value) => sum + value,0) / observed.length : null,
    observedCount: observed.length, applicableCount: values.length, unknownCount: values.length - observed.length };
}
function validCriterion(c) {
  if (!keys(c, ['id','kind','description','outcome','reason']) ||
    !['pass','fail','unknown'].includes(c.outcome) || !['artifact','verification','review','resume','constraint'].includes(c.kind) ||
    typeof c.description !== 'string' || c.description.length > 1000 || !reasons.has(c.reason) ||
    (c.outcome === 'pass') !== (c.reason === null)) return false;
  if (!(c.kind === 'constraint' ? /^constraint:[a-z][a-z0-9-]{0,79}$/.test(c.id || '') : c.id === c.kind)) return false;
  if (c.outcome === 'pass') return true;
  const allowed = c.kind === 'artifact' ? { unknown: ['execution_incomplete','evidence_unavailable'], fail: ['execution_failed','missing_evidence','required_artifact_absent'] } :
    c.kind === 'constraint' ? { unknown: ['evidence_unavailable'], fail: ['missing_evidence'] } :
    c.kind === 'resume' ? { unknown: ['event_gap'], fail: ['missing_evidence','duplicate_job'] } :
    { unknown: ['execution_incomplete'], fail: c.kind === 'review'
      ? ['execution_failed','missing_evidence','wrong_job','stale_evidence','contract_mismatch','review_rejected']
      : ['execution_failed','missing_evidence','wrong_job','stale_evidence','contract_mismatch','missing_verifier','verification_failed'] };
  return allowed[c.outcome].includes(c.reason);
}
function derivedCategorical(items, flag, value, labels) {
  const applicable = items.filter(item => item[flag]);
  return { [labels[0]]: applicable.filter(item => item[value] === labels[0]).length,
    [labels[1]]: applicable.filter(item => item[value] === labels[1]).length,
    unknown: applicable.filter(item => item[value] === 'unknown').length, applicable: applicable.length };
}
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
    if (!keys(item, ['taskId','criteria','taskSuccess','reason','constraintRetention','resumeCorrectness','latencyMs','usage','hasTrace','constraintApplicable','resumeApplicable']) ||
      item.taskId !== ids[i] || item.hasTrace !== observed.includes(ids[i]) || typeof item.taskSuccess !== 'boolean' ||
      typeof item.constraintApplicable !== 'boolean' || typeof item.resumeApplicable !== 'boolean' ||
      !['retained','lost','unknown'].includes(item.constraintRetention) || !['correct','incorrect','unknown'].includes(item.resumeCorrectness) ||
      !Array.isArray(item.criteria) || item.criteria.length > 16 || item.criteria.some(c => !validCriterion(c)) ||
      item.latencyMs !== null && (!Number.isInteger(item.latencyMs) || item.latencyMs < 0 || item.latencyMs > 86_400_000) ||
      !keys(item.usage, ['totalTokens','costUsd','observedResponses']) ||
      !Number.isInteger(item.usage.observedResponses) || item.usage.observedResponses < 0 || item.usage.observedResponses > 100_000 ||
      item.usage.totalTokens !== null && (!Number.isFinite(item.usage.totalTokens) || item.usage.totalTokens < 0 || item.usage.totalTokens > 50_000_000) ||
      item.usage.costUsd !== null && (!Number.isFinite(item.usage.costUsd) || item.usage.costUsd < 0 || item.usage.costUsd > 1_000_000) ||
      item.usage.observedResponses === 0 && (item.usage.totalTokens !== null || item.usage.costUsd !== null))
      throw new Error('Invalid per-task report result');
    if (!item.hasTrace) {
      if (item.reason !== 'missing_outcome' || item.taskSuccess || item.criteria.length || item.constraintRetention !== 'unknown' ||
        item.resumeCorrectness !== 'unknown' || item.latencyMs !== null || item.usage.totalTokens !== null ||
        item.usage.costUsd !== null || item.usage.observedResponses !== 0) throw new Error('Invalid missing outcome');
      continue;
    }
    const criteria = item.criteria;
    if (item.reason !== null || new Set(criteria.map(c => c.id)).size !== criteria.length ||
      criteria.filter(c => c.kind === 'artifact').length !== 1 ||
      ['verification','review','resume'].some(kind => criteria.filter(c => c.kind === kind).length > 1) ||
      item.constraintApplicable !== criteria.some(c => c.kind === 'constraint') ||
      item.resumeApplicable !== criteria.some(c => c.kind === 'resume')) throw new Error('Invalid observed criteria');
    const constraints = criteria.filter(c => c.kind === 'constraint');
    const retention = !item.constraintApplicable ? 'unknown' : constraints.some(c => c.outcome === 'fail') ? 'lost' :
      constraints.every(c => c.outcome === 'pass') ? 'retained' : 'unknown';
    const resume = criteria.find(c => c.kind === 'resume');
    const correctness = !resume ? 'unknown' : resume.outcome === 'pass' ? 'correct' : resume.outcome === 'fail' ? 'incorrect' : 'unknown';
    const success = criteria.filter(c => ['artifact','verification','review'].includes(c.kind)).every(c => c.outcome === 'pass') &&
      (!item.constraintApplicable || retention === 'retained') && (!item.resumeApplicable || correctness === 'correct');
    if (item.constraintRetention !== retention || item.resumeCorrectness !== correctness || item.taskSuccess !== success)
      throw new Error('Inconsistent per-task report result');
  }
  if (!keys(result.taskSuccess, ['passed','total','rate']) || result.taskSuccess.total !== ids.length ||
    result.taskSuccess.passed !== result.perTask.filter(item => item.taskSuccess).length ||
    result.taskSuccess.rate !== result.taskSuccess.passed / ids.length) throw new Error('Invalid task success aggregate');
  if (!same(result.constraintRetention, derivedCategorical(result.perTask,'constraintApplicable','constraintRetention',['retained','lost'])) ||
    !same(result.resumeCorrectness, derivedCategorical(result.perTask,'resumeApplicable','resumeCorrectness',['correct','incorrect'])) ||
    !same(result.latencyMs, aggregate(result.perTask.map(item => item.latencyMs))) ||
    !keys(result.usage, ['totalTokens','costUsd']) ||
    !same(result.usage.totalTokens, aggregate(result.perTask.map(item => item.usage.totalTokens))) ||
    !same(result.usage.costUsd, aggregate(result.perTask.map(item => item.usage.costUsd)))) throw new Error('Invalid report aggregate');
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
