import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitize as defaultSanitize } from './sanitize.mjs';

const exec = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = /^[0-9a-f]{64}$/;
const defaults = { maxFiles: 256, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxReadBytes: 64 * 1024 };
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`); }
export function validateArtifactConfig(raw = {}) {
  object(raw, 'artifacts');
  const caps = { maxFiles: 4096, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024, maxReadBytes: 256 * 1024 };
  for (const key of Object.keys(raw)) if (!(key in defaults)) throw new Error(`artifacts: unknown field ${key}`);
  const result = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = raw[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > caps[key]) throw new Error(`artifacts.${key}: invalid bound`);
    result[key] = value;
  }
  if (result.maxFileBytes > result.maxTotalBytes || result.maxReadBytes > result.maxFileBytes) throw new Error('artifacts: inconsistent bounds');
  return result;
}
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\p{Cc}\p{Cf}\\]/u.test(value) || path.posix.isAbsolute(value) || value !== value.normalize('NFC')) throw new Error('Unsafe artifact path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part !== part.trimEnd() || /^\.git$/i.test(part) || /^\.pi-mcp(?:-|$)/i.test(part))) throw new Error('Unsafe artifact path');
  return value;
}
export async function readRegular(file, maxBytes) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('Unsafe or oversized regular file');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('File changed during read');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('File changed during read');
    return { bytes, stat: before };
  } finally { await handle.close(); }
}
async function git(cwd, args, env = process.env) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 30000, env });
  return stdout;
}
const nulPaths = bytes => bytes.toString('utf8').split('\0').filter(Boolean);
async function changedPaths(worktree, baseCommit, env) {
  if (!/^[0-9a-f]{40}$/.test(baseCommit)) throw new Error('Invalid baseCommit');
  if (await fs.realpath(worktree) !== worktree || (await git(worktree, ['rev-parse', '--show-toplevel'], env)).toString().trim() !== worktree) throw new Error('Invalid canonical worktree root');
  const head = (await git(worktree, ['rev-parse', 'HEAD'], env)).toString().trim();
  if (head !== baseCommit) throw new Error('Worktree HEAD differs from selected base');
  const [tracked, untracked] = await Promise.all([
    git(worktree, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', baseCommit, '--'], env),
    git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], env),
  ]);
  return [...new Set([...nulPaths(tracked), ...nulPaths(untracked)])].sort();
}
export async function safeLstat(root, rel) {
  const parts = safeRelative(rel).split('/'); let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const st = await fs.lstat(current).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!st) return null;
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error(`Unsafe ancestor: ${rel}`);
    if (st.isSymbolicLink() || st.isFile() && st.nlink > 1) throw new Error(`Symlink or hardlink refused: ${rel}`);
    if (i === parts.length - 1) return st;
  }
}
async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, file);
}
export function textBytes(bytes) {
  if (bytes.includes(0)) return null;
  const decoded = bytes.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : null;
}
function sanitizeReportJson(decoded, sanitize, env) {
  let parsed;
  try { parsed = JSON.parse(decoded); } catch { return sanitize(decoded, env); }
  const statuses = new Set(['queued', 'starting', 'running', 'finalizing', 'completed', 'failed', 'cancelled', 'timed_out', 'turn_limit', 'interrupted', 'queue_expired', 'budget_limit', 'budget_unavailable', 'context_limit', 'idle_timeout', 'tool_failure_limit', 'quarantined', 'passed', 'pending', 'not_requested', 'skipped', 'unverified', 'mutated_or_incomplete', 'received', 'unknown']);
  const stopReasons = new Set(['stop', 'end_turn', 'error', 'aborted', 'other']);
  const reasons = new Set(['result_size_limit', 'public_output_limit', 'report_size_limit']);
  const visit = (value, key = '') => {
    if (typeof value === 'string') {
      if (key === 'status' && statuses.has(value) || key === 'stopReason' && stopReasons.has(value) || key === 'omittedReason' && reasons.has(value) || key === 'outputOmitted' && reasons.has(value)
        || ['beforeDigest', 'afterDigest', 'verifiedSnapshotDigest', 'inputSnapshotDigest', 'manifestSha256', 'sha256'].includes(key) && hex.test(value)
        || key === 'id' && /^[a-z][a-z0-9_-]{0,47}$/.test(value) || key === 'signal' && /^SIG[A-Z0-9]+$/.test(value)) return value;
      return sanitize(value, env);
    }
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, visit(item, childKey)]));
    return value;
  };
  return JSON.stringify(visit(parsed));
}
function validateBaseline(materialBaseline) {
  if (!Array.isArray(materialBaseline) || materialBaseline.length > 4096) throw new Error('Invalid material baseline');
  const paths = new Set();
  for (const item of materialBaseline) {
    safeRelative(item.path);
    if (!hex.test(item.sha256) || ![0o644, 0o755].includes(item.mode) || paths.has(item.path)) throw new Error('Invalid material baseline');
    paths.add(item.path);
  }
  return new Map(materialBaseline.map(item => [item.path, item]));
}
export async function snapshotArtifacts({ jobDir, worktree, baseCommit, config = {}, sanitize = defaultSanitize, env = process.env, materialBaseline = [], inputMaterialsDigest = null, reports = [] }) {
  const bounds = validateArtifactConfig(config);
  if (!path.isAbsolute(jobDir) || await fs.realpath(jobDir) !== jobDir) throw new Error('Invalid canonical job directory');
  if (!Array.isArray(reports) || reports.length > 4) throw new Error('Invalid artifact reports');
  const reportFiles = { result: 'result.json', verification: 'verification.json', stdout: 'stdout.log', stderr: 'stderr.log' };
  const reportNames = new Set();
  for (const report of reports) {
    object(report, 'artifact report');
    if (Object.keys(report).some(key => !['name', 'file'].includes(key)) || reportFiles[report.name] !== report.file || reportNames.has(report.name)) throw new Error('Invalid artifact report');
    reportNames.add(report.name);
  }
  const baseline = validateBaseline(materialBaseline);
  if (inputMaterialsDigest !== null && !hex.test(inputMaterialsDigest)) throw new Error('Invalid inputMaterialsDigest');
  const allBefore = [...new Set([...(await changedPaths(worktree, baseCommit, env)), ...baseline.keys()])].sort();
  const before = [], unchangedBaseline = [], unsafePaths = [];
  for (const rel of allBefore) {
    try { safeRelative(rel); }
    catch { unsafePaths.push(rel); continue; }
    const original = baseline.get(rel);
    if (original) {
      const stat = await safeLstat(worktree, rel).catch(() => null);
      if (stat?.isFile() && (stat.mode & 0o777) === original.mode) {
        const current = await readRegular(path.join(worktree, rel), 16 * 1024 * 1024).catch(() => null);
        if (current && sha(current.bytes) === original.sha256) { unchangedBaseline.push(original); continue; }
      }
    }
    before.push(rel);
  }
  const root = path.join(jobDir, 'artifacts');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(path.join(root, 'private'), { mode: 0o700 });
  await fs.mkdir(path.join(root, 'public'), { mode: 0o700 });
  const privateEntries = [], entries = [], omissions = [];
  let omittedCount = 0;
  const omit = value => { omittedCount++; if (omissions.length < 4096) omissions.push(value); };
  let total = 0, publicTotal = 0, checkpointComplete = unsafePaths.length === 0, exportComplete = unsafePaths.length === 0;
  for (const rel of unsafePaths) omit({ path: sanitize(rel.slice(0, 1024).replace(/[\p{Cc}\p{Cf}]/gu, '?'), env), reason: 'unsafe_path' });
  for (let index = 0; index < before.length; index++) {
    const rel = before[index], id = `a${String(index + 1).padStart(6, '0')}`;
    const publicPath = sanitize(rel, env);
    if (index >= bounds.maxFiles) { omit({ path: publicPath, reason: 'file_count_limit' }); checkpointComplete = exportComplete = false; continue; }
    let stat;
    try { stat = await safeLstat(worktree, rel); }
    catch { omit({ path: publicPath, reason: 'unsafe_file_type' }); checkpointComplete = exportComplete = false; continue; }
    if (stat && !stat.isFile()) { omit({ path: publicPath, reason: 'unsafe_file_type' }); checkpointComplete = exportComplete = false; continue; }
    if (!stat) {
      privateEntries.push({ id, path: rel, type: 'delete' });
      const redacted = publicPath !== rel;
      entries.push({ id, path: publicPath, type: 'delete', size: 0, sha256: sha(Buffer.alloc(0)), encoding: 'none', redacted, complete: !redacted, applicable: !redacted });
      if (redacted) exportComplete = false;
      continue;
    }
    if (stat.size > bounds.maxFileBytes || total + stat.size > bounds.maxTotalBytes) {
      omit({ path: publicPath, reason: stat.size > bounds.maxFileBytes ? 'file_size_limit' : 'total_size_limit', sourceSize: stat.size });
      checkpointComplete = exportComplete = false; continue;
    }
    let bytes;
    try { ({ bytes } = await readRegular(path.join(worktree, rel), bounds.maxFileBytes)); }
    catch { omit({ path: publicPath, reason: 'mutated_during_snapshot' }); checkpointComplete = exportComplete = false; continue; }
    const after = await safeLstat(worktree, rel);
    if (!after || !after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || bytes.length !== stat.size) {
      omit({ path: publicPath, reason: 'mutated_during_snapshot' }); checkpointComplete = exportComplete = false; continue;
    }
    total += bytes.length;
    await fs.writeFile(path.join(root, 'private', id), bytes, { flag: 'wx', mode: 0o600 });
    privateEntries.push({ id, path: rel, type: 'file', size: bytes.length, sha256: sha(bytes), mode: stat.mode & 0o777 });
    const decoded = textBytes(bytes);
    const cleaned = sanitize(decoded ?? bytes.toString('latin1'), env);
    if (typeof cleaned !== 'string') throw new Error('sanitize must return text');
    const utf8Probe = decoded === null ? sanitize(bytes.toString('utf8'), env) : null;
    if (decoded === null && (cleaned !== bytes.toString('latin1') || utf8Probe !== bytes.toString('utf8'))) {
      entries.push({ id, path: publicPath, type: 'file', size: 0, sha256: null, encoding: 'omitted', complete: false, applicable: false, redacted: true, omittedReason: 'secret_bearing_binary' });
      exportComplete = false; continue;
    }
    const publicBytes = decoded === null ? bytes : Buffer.from(cleaned);
    if (publicBytes.length > bounds.maxFileBytes || publicTotal + publicBytes.length > bounds.maxTotalBytes) {
      entries.push({ id, path: publicPath, type: 'file', size: 0, sha256: null, encoding: 'omitted', complete: false, applicable: false, redacted: decoded !== null && cleaned !== decoded, omittedReason: 'public_output_limit' });
      exportComplete = false; continue;
    }
    await fs.writeFile(path.join(root, 'public', id), publicBytes, { flag: 'wx', mode: 0o600 });
    publicTotal += publicBytes.length;
    const redacted = decoded !== null && cleaned !== decoded || publicPath !== rel;
    entries.push({ id, path: publicPath, type: 'file', size: publicBytes.length, sha256: sha(publicBytes), encoding: decoded === null ? 'base64' : 'utf8', mode: stat.mode & 0o777, redacted, complete: !redacted, applicable: !redacted });
    if (redacted) exportComplete = false;
  }
  const afterPaths = [...new Set([...(await changedPaths(worktree, baseCommit, env)), ...baseline.keys()])].sort();
  if (JSON.stringify(allBefore) !== JSON.stringify(afterPaths)) { omit({ reason: 'mutation_during_snapshot' }); checkpointComplete = exportComplete = false; }
  for (const entry of privateEntries.filter(item => item.type === 'file')) {
    const current = await readRegular(path.join(worktree, entry.path), bounds.maxFileBytes).catch(() => null);
    if (!current || sha(current.bytes) !== entry.sha256 || (current.stat.mode & 0o777) !== entry.mode) {
      omit({ path: sanitize(entry.path, env), reason: 'mutated_after_capture' }); checkpointComplete = exportComplete = false;
    }
  }
  for (const original of unchangedBaseline) {
    const current = await readRegular(path.join(worktree, original.path), 16 * 1024 * 1024).catch(() => null);
    if (!current || sha(current.bytes) !== original.sha256 || (current.stat.mode & 0o777) !== original.mode) {
      omit({ path: sanitize(original.path, env), reason: 'imported_material_mutated_after_capture' }); checkpointComplete = exportComplete = false;
    }
  }
  const reportChecks = [];
  for (const [reportIndex, report] of reports.entries()) {
    const id = `a${String(before.length + reportIndex + 1).padStart(6, '0')}`;
    const stat = await safeLstat(jobDir, report.file).catch(() => null);
    if (!stat?.isFile() || stat.size > bounds.maxFileBytes || total + stat.size > bounds.maxTotalBytes || entries.length >= bounds.maxFiles) {
      omit({ path: `reports/${report.name}`, reason: !stat ? 'report_unavailable' : 'report_limit' }); exportComplete = false; continue;
    }
    let bytes;
    try { ({ bytes } = await readRegular(path.join(jobDir, report.file), bounds.maxFileBytes)); }
    catch { omit({ path: `reports/${report.name}`, reason: 'report_mutated' }); exportComplete = false; continue; }
    const decoded = textBytes(bytes);
    if (decoded === null) { omit({ path: `reports/${report.name}`, reason: 'binary_report' }); exportComplete = false; continue; }
    const cleaned = ['result', 'verification'].includes(report.name) ? sanitizeReportJson(decoded, sanitize, env) : sanitize(decoded, env);
    const publicBytes = Buffer.from(cleaned);
    if (publicBytes.length > bounds.maxFileBytes || publicTotal + publicBytes.length > bounds.maxTotalBytes) {
      omit({ path: `reports/${report.name}`, reason: 'public_output_limit' }); exportComplete = false; continue;
    }
    total += bytes.length;
    await fs.writeFile(path.join(root, 'public', id), publicBytes, { flag: 'wx', mode: 0o600 });
    publicTotal += publicBytes.length;
    const redacted = cleaned !== decoded;
    entries.push({ id, path: `reports/${report.name}`, type: 'report', size: publicBytes.length, sha256: sha(publicBytes), encoding: 'utf8', redacted, complete: !redacted, applicable: false });
    reportChecks.push({ report, sourceSha256: sha(bytes) });
    if (redacted) exportComplete = false;
  }
  const finalPaths = [...new Set([...(await changedPaths(worktree, baseCommit, env)), ...baseline.keys()])].sort();
  if (JSON.stringify(allBefore) !== JSON.stringify(finalPaths)) { omit({ reason: 'mutation_during_reports' }); checkpointComplete = exportComplete = false; }
  for (const entry of privateEntries.filter(item => item.type === 'file')) {
    const current = await readRegular(path.join(worktree, entry.path), bounds.maxFileBytes).catch(() => null);
    if (!current || sha(current.bytes) !== entry.sha256 || (current.stat.mode & 0o777) !== entry.mode) {
      omit({ path: sanitize(entry.path, env), reason: 'mutated_during_reports' }); checkpointComplete = exportComplete = false;
    }
  }
  for (const original of unchangedBaseline) {
    const current = await readRegular(path.join(worktree, original.path), 16 * 1024 * 1024).catch(() => null);
    if (!current || sha(current.bytes) !== original.sha256 || (current.stat.mode & 0o777) !== original.mode) {
      omit({ path: sanitize(original.path, env), reason: 'imported_material_mutated_during_reports' }); checkpointComplete = exportComplete = false;
    }
  }
  for (const item of reportChecks) {
    const current = await readRegular(path.join(jobDir, item.report.file), bounds.maxFileBytes).catch(() => null);
    if (!current || sha(current.bytes) !== item.sourceSha256) { omit({ path: `reports/${item.report.name}`, reason: 'report_mutated_after_capture' }); exportComplete = false; }
  }
  const checkpoint = { version: 1, baseCommit, materialBaseline, inputMaterialsDigest, entries: privateEntries, complete: checkpointComplete, inputSnapshotDigest: sha(JSON.stringify({ baseCommit, inputMaterialsDigest, materialBaseline, entries: privateEntries })) };
  await atomicJson(path.join(root, 'private', 'checkpoint.json'), checkpoint);
  const manifest = { version: 1, entries, omissions, omittedCount, omissionsTruncated: omittedCount > omissions.length, checkpointComplete, exportComplete, complete: exportComplete, truncated: omittedCount > 0, applicable: exportComplete, sourceBaselineCommit: baseCommit, inputMaterialsDigest, inputSnapshotDigest: checkpoint.inputSnapshotDigest, maxReadBytes: bounds.maxReadBytes };
  manifest.manifestSha256 = sha(JSON.stringify(manifest));
  await atomicJson(path.join(root, 'manifest.json'), manifest);
  return manifest;
}
export async function manifestAt(jobDir) {
  await safeLstat(jobDir, 'artifacts/manifest.json');
  const { bytes } = await readRegular(path.join(jobDir, 'artifacts', 'manifest.json'), 12 * 1024 * 1024);
  const manifest = JSON.parse(bytes);
  const copy = { ...manifest }; delete copy.manifestSha256;
  if (!hex.test(manifest.manifestSha256) || sha(JSON.stringify(copy)) !== manifest.manifestSha256) throw new Error('Artifact manifest integrity failure');
  if (!Array.isArray(manifest.entries) || manifest.entries.length > 4096 || !Array.isArray(manifest.omissions) || manifest.omissions.length > 4096 || !Number.isSafeInteger(manifest.maxReadBytes) || manifest.maxReadBytes < 1 || manifest.maxReadBytes > 256 * 1024) throw new Error('Invalid artifact manifest');
  const ids = new Set();
  for (const item of manifest.entries) {
    if (!/^a\d{6}$/.test(item.id) || ids.has(item.id) || !['utf8', 'base64', 'omitted', 'none'].includes(item.encoding) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 16 * 1024 * 1024) throw new Error('Invalid artifact manifest entry');
    if (['utf8', 'base64'].includes(item.encoding) && !hex.test(item.sha256)) throw new Error('Invalid artifact digest');
    ids.add(item.id);
  }
  return manifest;
}
export async function attachArtifactReport({ jobDir, name, file, config = {}, sanitize = defaultSanitize, env = process.env }) {
  const reportFiles = { result: 'result.json', verification: 'verification.json', stdout: 'stdout.log', stderr: 'stderr.log' };
  if (reportFiles[name] !== file || !path.isAbsolute(jobDir) || await fs.realpath(jobDir) !== jobDir) throw new Error('Invalid artifact report attachment');
  const bounds = validateArtifactConfig(config);
  const manifest = await manifestAt(jobDir);
  if (manifest.entries.some(item => item.path === `reports/${name}`)) throw new Error('Artifact report already attached');
  const markOmitted = reason => {
    manifest.omittedCount++;
    if (manifest.omissions.length < 4096) manifest.omissions.push({ path: `reports/${name}`, reason });
    manifest.omissionsTruncated = manifest.omittedCount > manifest.omissions.length;
    manifest.exportComplete = manifest.complete = manifest.applicable = false;
    manifest.truncated = true;
  };
  const publicTotal = manifest.entries.reduce((sum, item) => sum + (item.encoding === 'utf8' || item.encoding === 'base64' ? item.size : 0), 0);
  let bytes = null;
  try { await safeLstat(jobDir, file); bytes = (await readRegular(path.join(jobDir, file), bounds.maxFileBytes)).bytes; }
  catch { markOmitted('report_unavailable_or_unsafe'); }
  if (bytes && manifest.entries.length >= bounds.maxFiles) { markOmitted('report_count_limit'); bytes = null; }
  if (bytes && textBytes(bytes) === null) { markOmitted('binary_report'); bytes = null; }
  let publicBytes;
  if (bytes) {
    const cleaned = ['result', 'verification'].includes(name) ? sanitizeReportJson(bytes.toString('utf8'), sanitize, env) : sanitize(bytes.toString('utf8'), env);
    if (typeof cleaned !== 'string') throw new Error('sanitize must return text');
    publicBytes = Buffer.from(cleaned);
    if (publicBytes.length > bounds.maxFileBytes || publicTotal + publicBytes.length > bounds.maxTotalBytes) { markOmitted('public_output_limit'); bytes = null; }
    else {
      const highest = manifest.entries.reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0);
      if (highest >= 999999) { markOmitted('report_count_limit'); bytes = null; }
      else {
        const id = `a${String(highest + 1).padStart(6, '0')}`;
        await fs.writeFile(path.join(jobDir, 'artifacts', 'public', id), publicBytes, { flag: 'wx', mode: 0o600 });
        const redacted = !publicBytes.equals(bytes);
        manifest.entries.push({ id, path: `reports/${name}`, type: 'report', size: publicBytes.length, sha256: sha(publicBytes), encoding: 'utf8', redacted, complete: !redacted, applicable: false });
        if (redacted) { manifest.exportComplete = manifest.complete = manifest.applicable = false; }
      }
    }
  }
  const copy = { ...manifest }; delete copy.manifestSha256;
  manifest.manifestSha256 = sha(JSON.stringify(copy));
  await atomicJson(path.join(jobDir, 'artifacts', 'manifest.json'), manifest);
  return manifest;
}
export async function exportArtifactBundle(jobDir) {
  const manifest = await manifestAt(jobDir), blobs = {};
  for (const entry of manifest.entries) {
    if (!['utf8', 'base64'].includes(entry.encoding)) continue;
    await safeLstat(jobDir, `artifacts/public/${entry.id}`);
    const { bytes } = await readRegular(path.join(jobDir, 'artifacts', 'public', entry.id), 16 * 1024 * 1024);
    if (bytes.length !== entry.size || sha(bytes) !== entry.sha256) throw new Error('Artifact integrity failure');
    blobs[entry.id] = bytes.toString('base64');
  }
  return { version: 1, manifest, blobs };
}
export async function listArtifacts(jobDir, { cursor = null, limit = 50, omissionCursor = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid artifact page limit');
  const manifest = await manifestAt(jobDir);
  const start = cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(start) || start < 0 || start > manifest.entries.length || cursor !== null && String(start) !== String(cursor)) throw new Error('Invalid artifact cursor');
  const entries = manifest.entries.slice(start, start + limit);
  const nextCursor = start + entries.length < manifest.entries.length ? String(start + entries.length) : null;
  const omissionStart = omissionCursor === null ? 0 : Number(omissionCursor);
  if (!Number.isSafeInteger(omissionStart) || omissionStart < 0 || omissionStart > manifest.omissions.length || omissionCursor !== null && String(omissionStart) !== String(omissionCursor)) throw new Error('Invalid omission cursor');
  const omissions = manifest.omissions.slice(omissionStart, omissionStart + limit);
  const nextOmissionCursor = omissionStart + omissions.length < manifest.omissions.length ? String(omissionStart + omissions.length) : null;
  return { version: manifest.version, entries, nextCursor, omissions, nextOmissionCursor, omittedCount: manifest.omittedCount, omissionsTruncated: manifest.omissionsTruncated, complete: manifest.complete, checkpointComplete: manifest.checkpointComplete, exportComplete: manifest.exportComplete, truncated: manifest.truncated, applicable: manifest.applicable, sourceBaselineCommit: manifest.sourceBaselineCommit, inputMaterialsDigest: manifest.inputMaterialsDigest, manifestSha256: manifest.manifestSha256, inputSnapshotDigest: manifest.inputSnapshotDigest };
}
export async function readArtifact(jobDir, { artifact_id, offset = 0, length = 65536 } = {}) {
  if (!/^a\d{6}$/.test(artifact_id || '')) throw new Error('Invalid artifact_id');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 256 * 1024) throw new Error('Invalid artifact range');
  const manifest = await manifestAt(jobDir);
  const entry = manifest.entries.find(item => item.id === artifact_id);
  if (!entry || !['utf8', 'base64'].includes(entry.encoding)) throw new Error('Artifact content unavailable');
  if (offset > entry.size) throw new Error('Artifact offset beyond EOF');
  const bounded = Math.min(length, manifest.maxReadBytes, 256 * 1024);
  await safeLstat(jobDir, `artifacts/public/${artifact_id}`);
  const { bytes } = await readRegular(path.join(jobDir, 'artifacts', 'public', artifact_id), 16 * 1024 * 1024);
  if (bytes.length !== entry.size || sha(bytes) !== entry.sha256) throw new Error('Artifact integrity failure');
  const slice = bytes.subarray(offset, offset + bounded), nextOffset = offset + slice.length;
  return { artifact_id, offset, data_base64: slice.toString('base64'), encoding: 'base64', sha256: sha(slice), totalSha256: entry.sha256, nextOffset, eof: nextOffset === bytes.length, size: bytes.length };
}
// Shared shape/hash validation for the private checkpoint, usable by a reader
// that only needs the raw (unsanitized) per-entry paths it records — e.g. to
// confirm a public manifest entry's sanitized path was not itself redacted —
// without restoreCheckpoint's own worktree-mutating restore semantics or its
// stricter `complete` requirement.
export async function readCheckpoint(jobDir) {
  await safeLstat(jobDir, 'artifacts/private/checkpoint.json');
  const checkpoint = JSON.parse((await readRegular(path.join(jobDir, 'artifacts', 'private', 'checkpoint.json'), 2 * 1024 * 1024)).bytes);
  if (!/^[0-9a-f]{40}$/.test(checkpoint.baseCommit) || !Array.isArray(checkpoint.entries) || checkpoint.entries.length > 4096 || !hex.test(checkpoint.inputSnapshotDigest)) throw new Error('Invalid checkpoint manifest');
  if (sha(JSON.stringify({ baseCommit: checkpoint.baseCommit, inputMaterialsDigest: checkpoint.inputMaterialsDigest, materialBaseline: checkpoint.materialBaseline, entries: checkpoint.entries })) !== checkpoint.inputSnapshotDigest) throw new Error('Checkpoint manifest integrity failure');
  return checkpoint;
}
export async function restoreCheckpoint({ jobDir, worktree, env = process.env }) {
  const root = path.join(jobDir, 'artifacts', 'private');
  await safeLstat(jobDir, 'artifacts/private/checkpoint.json');
  const checkpoint = JSON.parse((await readRegular(path.join(root, 'checkpoint.json'), 2 * 1024 * 1024)).bytes);
  if (!checkpoint.complete) throw new Error('Checkpoint incomplete');
  if (!/^[0-9a-f]{40}$/.test(checkpoint.baseCommit) || !Array.isArray(checkpoint.entries) || checkpoint.entries.length > 4096 || !hex.test(checkpoint.inputSnapshotDigest)) throw new Error('Invalid checkpoint manifest');
  if (sha(JSON.stringify({ baseCommit: checkpoint.baseCommit, inputMaterialsDigest: checkpoint.inputMaterialsDigest, materialBaseline: checkpoint.materialBaseline, entries: checkpoint.entries })) !== checkpoint.inputSnapshotDigest) throw new Error('Checkpoint manifest integrity failure');
  const head = (await git(worktree, ['rev-parse', 'HEAD'], env)).toString().trim();
  if (head !== checkpoint.baseCommit) throw new Error('Checkpoint base mismatch');
  const baseline = validateBaseline(checkpoint.materialBaseline || []);
  const existing = await changedPaths(worktree, checkpoint.baseCommit, env);
  if (existing.some(rel => !baseline.has(rel))) throw new Error('Restore worktree has unrelated changes');
  for (const item of baseline.values()) {
    const stat = await safeLstat(worktree, item.path).catch(() => null);
    const current = stat?.isFile() ? await readRegular(path.join(worktree, item.path), 16 * 1024 * 1024).catch(() => null) : null;
    if (!current || (current.stat.mode & 0o777) !== item.mode || sha(current.bytes) !== item.sha256) throw new Error('Imported material baseline mismatch');
  }
  const staged = [];
  const seen = new Set();
  for (const entry of checkpoint.entries) {
    safeRelative(entry.path);
    if (!/^a\d{6}$/.test(entry.id) || seen.has(entry.path) || !['file', 'delete'].includes(entry.type)) throw new Error('Invalid checkpoint entry');
    seen.add(entry.path);
    const current = await safeLstat(worktree, entry.path);
    if (current && (!current.isFile() || entry.type !== 'delete' && entry.type !== 'file')) throw new Error('Checkpoint collision');
    if (current && !baseline.has(entry.path)) {
      const tracked = (await git(worktree, ['ls-files', '--error-unmatch', '--', entry.path], env).catch(() => Buffer.alloc(0))).length > 0;
      if (!tracked) throw new Error('Checkpoint target collision');
    }
    if (entry.type === 'file') {
      if (!hex.test(entry.sha256) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('Invalid checkpoint entry');
      await safeLstat(jobDir, `artifacts/private/${entry.id}`);
      const { bytes } = await readRegular(path.join(root, entry.id), 16 * 1024 * 1024);
      if (bytes.length !== entry.size || sha(bytes) !== entry.sha256) throw new Error('Checkpoint integrity failure');
      staged.push({ entry, bytes });
    } else if (entry.type === 'delete') staged.push({ entry });
    else throw new Error('Invalid checkpoint entry');
  }
  for (const { entry, bytes } of staged) {
    const target = path.join(worktree, entry.path);
    await safeLstat(worktree, entry.path);
    if (entry.type === 'delete') await fs.rm(target, { force: true });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const parent = await fs.realpath(path.dirname(target));
      if (parent !== worktree && !parent.startsWith(worktree + path.sep)) throw new Error('Checkpoint parent escaped worktree');
      const existed = !!await safeLstat(worktree, entry.path);
      const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CREAT | (existed ? fsConstants.O_TRUNC : fsConstants.O_EXCL), entry.mode);
      try { await handle.writeFile(bytes); await handle.chmod(entry.mode); } finally { await handle.close(); }
    }
  }
  return { restored: staged.length, inputSnapshotDigest: checkpoint.inputSnapshotDigest, baseCommit: checkpoint.baseCommit };
}
