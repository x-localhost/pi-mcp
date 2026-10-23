import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MAX_ENTRIES = 1024, MAX_FILE = 8 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
function plain(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be object`); }
function keys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${name}: unknown field ${key}`); }
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\p{Cc}\p{Cf}\\]/u.test(value) || path.posix.isAbsolute(value) || value !== value.normalize('NFC')) throw new Error('Unsafe material path');
  if (value.split('/').some(x => !x || x === '.' || x === '..' || x !== x.trimEnd() || /^\.git$/i.test(x) || /^\.pi-mcp(?:-|$)/i.test(x))) throw new Error('Unsafe material path');
  return value;
}
async function readPinned(file, maxBytes) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('Unsafe material manifest');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw new Error('Material manifest mutated'); offset += bytesRead; }
    const after = await handle.stat();
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Material manifest mutated');
    return bytes;
  } finally { await handle.close(); }
}
async function safeStat(root, rel) {
  let current = root; const parts = safePath(rel).split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await fs.lstat(current).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) return null;
    if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw new Error(`Unsafe material path: ${rel}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Material path collision: ${rel}`);
    if (i === parts.length - 1) return stat;
  }
}
function entrySchema(entry) {
  plain(entry, 'material entry'); keys(entry, ['path', 'sha256', 'size', 'mode', 'data_base64', 'expectedOriginalSha256'], 'material entry');
  safePath(entry.path);
  if (!SHA.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE || ![0o644, 0o755].includes(entry.mode)) throw new Error('Invalid material entry');
  if (entry.expectedOriginalSha256 !== undefined && !SHA.test(entry.expectedOriginalSha256)) throw new Error('Invalid expected original hash');
  if (typeof entry.data_base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data_base64)) throw new Error('Invalid material blob');
  const bytes = Buffer.from(entry.data_base64, 'base64');
  if (bytes.length !== entry.size || sha(bytes) !== entry.sha256) throw new Error('Material blob digest mismatch');
  return bytes;
}
function validateBundle(value) {
  plain(value, 'material bundle'); keys(value, ['version', 'sourceCommit', 'entries'], 'material bundle');
  if (value.version !== 1 || !COMMIT.test(value.sourceCommit) || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw new Error('Invalid material manifest');
  const seen = new Set(); let total = 0;
  const staged = value.entries.map(entry => {
    const bytes = entrySchema(entry); total += bytes.length;
    if (total > MAX_TOTAL) throw new Error('Material total size limit');
    const folded = entry.path.toLowerCase();
    if (seen.has(folded)) throw new Error('Duplicate material path');
    seen.add(folded); return { entry, bytes };
  });
  const paths = [...seen];
  for (const item of paths) if (paths.some(other => other !== item && other.startsWith(`${item}/`))) throw new Error('Material path alias conflict');
  return staged;
}
export function validateMaterialBundle(value) {
  const staged = validateBundle(value);
  return { sourceCommit: value.sourceCommit, fileCount: staged.length, totalBytes: staged.reduce((sum, item) => sum + item.bytes.length, 0) };
}
export async function packMaterial({ sourceDir, sourceCommit, expectedOriginalDir = null }) {
  if (!COMMIT.test(sourceCommit || '')) throw new Error('Invalid sourceCommit');
  const root = await fs.realpath(sourceDir);
  const entries = []; let total = 0;
  async function walk(rel = '') {
    const listing = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    for (const item of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${item.name}` : item.name;
      safePath(child);
      const st = await fs.lstat(path.join(root, child));
      if (st.isSymbolicLink() || st.nlink > 1 && st.isFile() || !st.isDirectory() && !st.isFile()) throw new Error(`Unsafe material file: ${child}`);
      if (st.isDirectory()) { await walk(child); continue; }
      if (entries.length >= MAX_ENTRIES || st.size > MAX_FILE || total + st.size > MAX_TOTAL) throw new Error('Material size or count limit');
      const bytes = await readPinned(path.join(root, child), MAX_FILE);
      const after = await fs.lstat(path.join(root, child));
      if (!after.isFile() || after.ino !== st.ino || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new Error('Material changed during pack');
      total += bytes.length;
      let expectedOriginalSha256;
      if (expectedOriginalDir) {
        const originalStat = await safeStat(expectedOriginalDir, child);
        if (!originalStat?.isFile()) throw new Error(`Missing original file: ${child}`);
        expectedOriginalSha256 = sha(await readPinned(path.join(expectedOriginalDir, child), MAX_FILE));
      }
      entries.push({ path: child, sha256: sha(bytes), size: bytes.length, mode: st.mode & 0o111 ? 0o755 : 0o644, data_base64: bytes.toString('base64'), ...(expectedOriginalSha256 ? { expectedOriginalSha256 } : {}) });
    }
  }
  await walk();
  const bundle = { version: 1, sourceCommit, entries };
  validateBundle(bundle);
  return Buffer.from(JSON.stringify(bundle) + '\n');
}
export function validateOfflineConfig(raw = {}, configDir) {
  plain(raw, 'offlineMaterials'); keys(raw, ['materials'], 'offlineMaterials');
  if (!path.isAbsolute(configDir || '')) throw new Error('Invalid configDir');
  const list = raw.materials ?? [];
  if (!Array.isArray(list) || list.length > 32) throw new Error('Invalid offline material declarations');
  const ids = new Set();
  const materials = list.map(item => {
    plain(item, 'offline material'); keys(item, ['id', 'manifestPath', 'manifestSha256', 'baseCommit', 'destination', 'collision', 'submoduleCommit'], 'offline material');
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(item.id || '') || ids.has(item.id)) throw new Error('Invalid or duplicate material id');
    ids.add(item.id);
    if (typeof item.manifestPath !== 'string' || !item.manifestPath || !SHA.test(item.manifestSha256) || !COMMIT.test(item.baseCommit)) throw new Error('Invalid pinned material');
    const destination = safePath(item.destination);
    const collision = item.collision ?? 'reject';
    if (!['reject', 'overlay-lfs', 'submodule'].includes(collision)) throw new Error('Invalid material collision policy');
    if (collision === 'submodule' && !COMMIT.test(item.submoduleCommit || '') || collision !== 'submodule' && item.submoduleCommit !== undefined) throw new Error('Invalid submodule commit pin');
    return { id: item.id, manifestPath: path.resolve(configDir, item.manifestPath), manifestSha256: item.manifestSha256, baseCommit: item.baseCommit, destination, collision, ...(item.submoduleCommit ? { submoduleCommit: item.submoduleCommit } : {}) };
  });
  const dirs = materials.map(x => x.destination.toLowerCase());
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) if (dirs[i] === dirs[j] || dirs[i].startsWith(`${dirs[j]}/`) || dirs[j].startsWith(`${dirs[i]}/`)) throw new Error('Material destination collision');
  return { materials };
}
async function git(worktree, args, env) {
  const { stdout } = await exec('git', ['-C', worktree, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, env });
  return stdout.trim();
}
export async function applyOfflineMaterials({ worktree, baseCommit, selections = [], config, env = process.env }) {
  if (!path.isAbsolute(worktree) || await fs.realpath(worktree) !== worktree || await git(worktree, ['rev-parse', '--show-toplevel'], env) !== worktree) throw new Error('Invalid canonical worktree root');
  if (!COMMIT.test(baseCommit || '') || await git(worktree, ['rev-parse', 'HEAD'], env) !== baseCommit) throw new Error('Offline material base mismatch');
  if (!Array.isArray(selections) || selections.length > 32 || new Set(selections).size !== selections.length || selections.some(x => typeof x !== 'string')) throw new Error('Invalid material selections');
  const normalized = validateOfflineConfig(config || {}, '/');
  const chosen = selections.map(id => { const item = normalized.materials.find(x => x.id === id); if (!item) throw new Error('Undeclared material selection'); return item; });
  const planned = [], identities = [], paths = new Set();
  for (const material of chosen) {
    if (material.baseCommit !== baseCommit) throw new Error('Pinned material base mismatch');
    const bytes = await readPinned(material.manifestPath, MAX_TOTAL * 2);
    if (bytes.length > MAX_TOTAL * 2 || sha(bytes) !== material.manifestSha256) throw new Error('Pinned material digest mismatch');
    const bundle = JSON.parse(bytes);
    if (bundle.sourceCommit !== baseCommit) throw new Error('Material source commit mismatch');
    const staged = validateBundle(bundle);
    const targetRoot = path.join(worktree, material.destination);
    const rootStat = await safeStat(worktree, material.destination);
    if (rootStat && !rootStat.isDirectory()) throw new Error('Material destination collision');
    if (material.collision === 'reject' && rootStat) throw new Error('Material destination collision');
    if (material.collision === 'submodule') {
      const tree = await git(worktree, ['ls-tree', baseCommit, '--', material.destination], env);
      if (!tree.startsWith(`160000 commit ${material.submoduleCommit}\t`)) throw new Error('Submodule destination must match pinned gitlink');
      if (rootStat && (await fs.readdir(targetRoot)).length) throw new Error('Submodule destination is not empty');
    }
    for (const { entry, bytes: blob } of staged) {
      const rel = `${material.destination}/${entry.path}`;
      const folded = rel.toLowerCase();
      if (paths.has(folded)) throw new Error('Material path collision'); paths.add(folded);
      const existing = await safeStat(worktree, rel);
      if (existing) {
        if (material.collision !== 'overlay-lfs' || !existing.isFile() || !entry.expectedOriginalSha256) throw new Error('Material target collision');
        const original = await readPinned(path.join(worktree, rel), MAX_FILE);
        if (sha(original) !== entry.expectedOriginalSha256) throw new Error('LFS original hash mismatch');
        const tracked = await git(worktree, ['ls-files', '--stage', '--', rel], env);
        if (!/^100(?:644|755) [0-9a-f]{40} 0\t/.test(tracked)) throw new Error('LFS overlay target must be tracked regular file');
      } else if (material.collision === 'overlay-lfs') throw new Error('LFS overlay target absent');
      planned.push({ rel, blob, mode: entry.mode, existing: existing ? await readPinned(path.join(worktree, rel), MAX_FILE) : null, oldMode: existing?.mode & 0o777 });
    }
    identities.push({ id: material.id, digest: material.manifestSha256, destination: material.destination, collision: material.collision, ...(material.submoduleCommit ? { submoduleCommit: material.submoduleCommit } : {}) });
  }
  const applied = [];
  async function writePlanned(item, bytes, replace, mode) {
    const target = path.join(worktree, item.rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const parent = await fs.realpath(path.dirname(target));
    if (parent !== worktree && !parent.startsWith(worktree + path.sep)) throw new Error('Material parent escaped worktree');
    const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CREAT | (replace ? fsConstants.O_TRUNC : fsConstants.O_EXCL), mode);
    try { await handle.writeFile(bytes); await handle.chmod(mode); }
    finally { await handle.close(); }
  }
  try {
    for (const item of planned) {
      await writePlanned(item, item.blob, !!item.existing, item.mode);
      applied.push(item);
    }
  } catch (error) {
    for (const item of applied.reverse()) {
      const target = path.join(worktree, item.rel);
      if (item.existing) await writePlanned(item, item.existing, true, item.oldMode);
      else await fs.rm(target, { force: true });
    }
    throw error;
  }
  return { materials: identities, inputMaterialsDigest: sha(JSON.stringify(identities)), materialBaseline: planned.map(item => ({ path: item.rel, sha256: sha(item.blob), mode: item.mode })), fileCount: planned.length };
}
