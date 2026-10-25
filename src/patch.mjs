import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitize as defaultSanitize } from './sanitize.mjs';
import { safeRelative, safeLstat, readRegular, textBytes } from './artifacts.mjs';

const exec = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const modeNumber = octalText => parseInt(octalText, 8) & 0o777;

// Strips any inherited GIT_* variable and layers on a fixed isolated
// configuration, so a job's own repository state (config, attributes,
// replace refs, hooks reachable only through a terminal prompt) can never
// influence how this privileged generation step invokes git. Exported so
// Manager.patch() can validate the target repository itself (repository())
// under the same isolation, rather than the unfiltered child environment an
// allowlisted GIT_DIR/GIT_WORK_TREE could otherwise redirect.
export function isolatedGitEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}
async function runGit(args, { cwd, env, maxBuffer = 8 * 1024 * 1024 }) {
  try {
    const { stdout } = await exec('git', args, { cwd, env, timeout: 30000, maxBuffer, encoding: 'buffer' });
    return stdout;
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr || '');
    throw new Error(`git ${args[2] || args[0]} failed: ${stderr.slice(0, 2000) || error.message}`);
  }
}
// Resolves exactly one literal path at the given base commit. Returns null
// when there is no tree entry there at all; the ancestor walk in
// resolveBaseFile() is what distinguishes "truly absent" from "hidden behind
// a non-tree ancestor", which ls-tree alone cannot tell apart (both yield no
// output for a deep pathspec).
async function lsTreeEntry(repository, baseCommit, relPath, env) {
  const stdout = await runGit(['-C', repository, 'ls-tree', '-z', '--full-tree', baseCommit, '--', relPath],
    { env: { ...env, GIT_LITERAL_PATHSPECS: '1' }, maxBuffer: 1024 * 1024 });
  const line = stdout.toString('utf8').split('\0').filter(Boolean)[0];
  if (!line) return null;
  const tab = line.indexOf('\t');
  const [mode, type, oid] = line.slice(0, tab).split(' ');
  return { mode, type, oid };
}
// Walks every ancestor of relPath, confirming each is a tree, before
// resolving the leaf. A symlink or gitlink anywhere on the path blocks git
// from seeing what is nominally "under" it; without this explicit walk that
// is indistinguishable from the path simply not existing, which would let an
// unsafe ancestor silently fall through as an ordinary "added" file instead
// of being refused.
async function resolveBaseFile(repository, baseCommit, relPath, env) {
  const segments = relPath.split('/');
  for (let i = 1; i < segments.length; i++) {
    const entry = await lsTreeEntry(repository, baseCommit, segments.slice(0, i).join('/'), env);
    if (!entry) return { exists: false };
    if (entry.type !== 'tree') return { exists: true, unsupported: true };
  }
  const leaf = await lsTreeEntry(repository, baseCommit, relPath, env);
  if (!leaf) return { exists: false };
  if (leaf.type !== 'blob' || !['100644', '100755'].includes(leaf.mode)) return { exists: true, unsupported: true };
  return { exists: true, mode: leaf.mode, oid: leaf.oid };
}
async function blobSize(repository, oid, env) {
  return Number((await runGit(['-C', repository, 'cat-file', '-s', oid], { env, maxBuffer: 64 })).toString('utf8').trim());
}
async function writeStagingFile(root, relPath, bytes, mode) {
  const target = path.join(root, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, bytes, { flag: 'wx' });
  await fs.chmod(target, mode);
}

// Folds a set of secret values into a digest of their own hashes, so the
// cache key can depend on "which secrets apply right now" without the key
// (or anything derived from it) ever holding the secret values themselves.
export function sanitizeConfigDigest(secrets) {
  return sha(JSON.stringify([...new Set(secrets)].map(sha).sort()));
}
export function patchKey({ generator, baseCommit, manifestSha256, sanitizeDigest }) {
  return sha(`${generator}:${baseCommit}:${manifestSha256}:${sanitizeDigest}`);
}

// Pure pagination over an already-generated, already-sanitized patch buffer.
// With valid UTF-8 (no NUL bytes) text content, a page ends at the last
// newline within maxBytes, falling back to a UTF-8 character boundary for a
// single overlong line; joining pages reproduces the exact text. Otherwise
// pages are raw byte ranges whose `text` field holds base64, decoded and
// joined by the caller. An offset beyond the end, or (for text) one that
// does not fall on a UTF-8 character boundary, is refused.
export function pagePatch(bytes, offset, maxBytes) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw new Error('Invalid patch offset');
  const decoded = textBytes(bytes);
  if (decoded === null) {
    const slice = bytes.subarray(offset, offset + maxBytes);
    const nextOffset = offset + slice.length;
    return { encoding: 'base64', text: slice.toString('base64'), nextOffset, eof: nextOffset === bytes.length };
  }
  if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error('Invalid patch offset: not on a character boundary');
  let end = Math.min(offset + maxBytes, bytes.length);
  if (end < bytes.length) {
    const newline = bytes.lastIndexOf(10, end - 1);
    if (newline >= offset) end = newline + 1;
    else while (end > offset && (bytes[end] & 0xc0) === 0x80) end--;
  }
  const slice = bytes.subarray(offset, end);
  return { encoding: 'utf8', text: slice.toString('utf8'), nextOffset: end, eof: end === bytes.length };
}

// Phase 1, run under the manager's submission lock so it cannot race a
// concurrent pi_cleanup of this same job directory: copies only the
// verified public bytes the diff will need into the b/ side of a fresh
// staging directory. Report entries are skipped by type, not by path, so a
// real source file at reports/<name> is still included. Manifest omissions
// and entries with encoding:'omitted' become omittedPaths. An entry whose
// public path does not match the private checkpoint's raw path for the same
// id was itself redacted; its path can never be trusted to look up the real
// file at the base commit, so it is left out entirely.
//
// A secret can be configured after the job's own export ran, so every public
// blob is re-checked against the *current* sanitize policy here, before any
// byte reaches git's binary (base85) encoding: text is sanitized again
// (reason export_text_sanitized on change), and a binary blob still carrying
// a secret is dropped from the candidate set entirely — on both sides, since
// a dropped candidate never reaches completeAndRunDiff's base resolution
// either — under secret_bearing_export_binary.
//
// A path itself can carry a secret too, and git's default core.quotePath
// renders any non-ASCII byte as a quoted octal escape in the diff header
// (e.g. "ë" as \303\253); a literal-text sanitize pass can never recognize
// that escaped form, so a secret hiding in a path could reach the cache even
// though the *displayed* metadata path looks clean. The fix is to never
// stage (or diff) an entry whose current-policy-sanitized path differs from
// its real path at all: such an entry is dropped entirely, before any
// content check, and reported as omitted (reason path_sanitized) with its
// sanitized path. Every candidate that does proceed therefore always has
// displayPath === path, so completeAndRunDiff never has to choose between a
// safe display path and the real one for diffing.
export async function stagePublicSide({ jobDir, manifest, checkpoint, stagingDir, sanitize = defaultSanitize, env = process.env, secrets = [] }) {
  const checkpointPaths = new Map((checkpoint.entries || []).map(entry => [entry.id, entry.path]));
  await fs.mkdir(path.join(stagingDir, 'a'), { mode: 0o700 });
  await fs.mkdir(path.join(stagingDir, 'b'), { mode: 0o700 });
  const reasons = new Set();
  let omittedCount = 0;
  const displayPath = raw => {
    const cleaned = sanitize(raw, env, secrets);
    if (cleaned !== raw) reasons.add('path_sanitized');
    return cleaned;
  };
  const omittedPaths = new Set();
  const omit = (shownPath, reason) => { reasons.add(reason); omittedPaths.add(shownPath); omittedCount++; };
  for (const omission of manifest.omissions) if (omission.path) omittedPaths.add(displayPath(omission.path));
  const candidates = [];
  for (const entry of manifest.entries) {
    if (entry.type !== 'file' && entry.type !== 'delete') continue;
    if (entry.encoding === 'omitted') { omittedPaths.add(displayPath(entry.path)); omittedCount++; continue; }
    const rawPath = checkpointPaths.get(entry.id);
    if (rawPath === undefined || (entry.redacted && rawPath !== entry.path)) { omit(displayPath(entry.path), 'redacted_path'); continue; }
    safeRelative(entry.path);
    const shownPath = displayPath(entry.path);
    if (shownPath !== entry.path) { omit(shownPath, 'path_sanitized'); continue; }
    if (entry.type === 'delete') { candidates.push({ id: entry.id, path: entry.path, displayPath: entry.path, type: 'delete' }); continue; }
    await safeLstat(jobDir, `artifacts/public/${entry.id}`);
    const { bytes: rawBytes } = await readRegular(path.join(jobDir, 'artifacts', 'public', entry.id), 16 * 1024 * 1024);
    if (rawBytes.length !== entry.size || sha(rawBytes) !== entry.sha256) throw new Error('Artifact integrity failure');
    const decoded = textBytes(rawBytes);
    let bytes = rawBytes;
    if (decoded !== null) {
      const cleaned = sanitize(decoded, env, secrets);
      if (cleaned !== decoded) { reasons.add('export_text_sanitized'); bytes = Buffer.from(cleaned, 'utf8'); }
    } else {
      const latin1 = rawBytes.toString('latin1'), utf8 = rawBytes.toString('utf8');
      if (sanitize(latin1, env, secrets) !== latin1 || sanitize(utf8, env, secrets) !== utf8) { omit(shownPath, 'secret_bearing_export_binary'); continue; }
    }
    await writeStagingFile(path.join(stagingDir, 'b'), entry.path, bytes, entry.mode);
    candidates.push({ id: entry.id, path: entry.path, displayPath: shownPath, type: 'file', mode: entry.mode, bytes });
  }
  return { candidates, omittedPaths, omittedCount, reasons };
}

// Phase 2, run after the lock is released so repository I/O never blocks
// other job submissions: resolves each candidate's base content from the
// literal base commit tree, applies the base-side secret and size policy,
// writes the a/ side, runs the single combined --no-index diff, and
// sanitizes the final patch text once more before anything is returned.
// maxPatchBytes bounds the *sanitized* result: a `[redacted]` replacement can
// only grow the text, so git's own maxBuffer (checked before sanitization)
// cannot by itself keep the published patch under this bound.
export async function completeAndRunDiff({ repository, baseCommit, candidates, stagingDir, bounds, sanitize = defaultSanitize, env = process.env, secrets = [], maxPatchBytes = 32 * 1024 * 1024 }) {
  const gitEnv = isolatedGitEnv(env);
  const reasons = new Set();
  const omittedPaths = new Set();
  let droppedCount = 0;
  let baseTotal = 0;
  const resolved = [];
  // A candidate disqualified here (unsupported/oversized/secret-bearing base)
  // must leave no trace: phase 1 already wrote its b/ side speculatively, so
  // dropping it here is what makes the exclusion total rather than letting it
  // leak through the diff as a spurious pure addition. Every candidate
  // reaching this point already has displayPath === path (stagePublicSide
  // dropped anything else), so the sanitized display path is always safe to
  // report here without a further current-policy check.
  const dropStagedPublicSide = candidate => candidate.type === 'file' ? fs.rm(path.join(stagingDir, 'b', candidate.path), { force: true }) : Promise.resolve();
  const dropCandidate = async (candidate, reason) => {
    reasons.add(reason); omittedPaths.add(candidate.displayPath); droppedCount++;
    await dropStagedPublicSide(candidate);
  };
  for (const candidate of candidates) {
    const base = await resolveBaseFile(repository, baseCommit, candidate.path, gitEnv);
    if (base.unsupported) { await dropCandidate(candidate, 'unsupported_base'); continue; }
    if (!base.exists) {
      if (candidate.type === 'delete') { reasons.add('unsupported_base'); omittedPaths.add(candidate.displayPath); droppedCount++; continue; }
      resolved.push({ path: candidate.displayPath, change: 'added', binary: textBytes(candidate.bytes) === null });
      continue;
    }
    const size = await blobSize(repository, base.oid, gitEnv);
    if (size > bounds.maxFileBytes || baseTotal + size > bounds.maxTotalBytes) { await dropCandidate(candidate, 'oversized_base'); continue; }
    const raw = await runGit(['-C', repository, 'cat-file', 'blob', base.oid], { env: gitEnv, maxBuffer: bounds.maxFileBytes + 1024 });
    baseTotal += size;
    const decoded = textBytes(raw);
    let baseBytes;
    if (decoded === null) {
      const latin1 = raw.toString('latin1'), utf8 = raw.toString('utf8');
      if (sanitize(latin1, env, secrets) !== latin1 || sanitize(utf8, env, secrets) !== utf8) { await dropCandidate(candidate, 'secret_bearing_base_binary'); continue; }
      baseBytes = raw;
    } else {
      const cleaned = sanitize(decoded, env, secrets);
      if (cleaned !== decoded) reasons.add('base_text_sanitized');
      baseBytes = Buffer.from(cleaned, 'utf8');
    }
    const baseMode = modeNumber(base.mode);
    await writeStagingFile(path.join(stagingDir, 'a'), candidate.path, baseBytes, baseMode);
    if (candidate.type === 'delete') { resolved.push({ path: candidate.displayPath, change: 'deleted', binary: decoded === null }); continue; }
    const sameContent = candidate.bytes.equals(baseBytes), sameMode = baseMode === candidate.mode;
    if (sameContent && sameMode) continue;
    resolved.push({ path: candidate.displayPath, change: sameContent ? 'mode' : 'modified', binary: decoded === null || textBytes(candidate.bytes) === null });
  }
  const diffEnv = { ...gitEnv, GIT_CEILING_DIRECTORIES: path.dirname(stagingDir) };
  let bytes;
  try {
    // core.quotePath=false is defense in depth: every candidate reaching
    // here already has a path requiring no sanitization (stagePublicSide
    // dropped the rest), so this only affects benign non-ASCII paths,
    // keeping their raw UTF-8 bytes in the header instead of a quoted octal
    // escape that a literal-text sanitize pass could never match against.
    bytes = (await exec('git', ['-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false', 'diff', '--no-index', '--binary', '--full-index', '--no-renames', '--no-prefix', '--no-ext-diff', '--no-textconv', '--no-color', 'a', 'b'],
      { cwd: stagingDir, env: diffEnv, timeout: 30000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' })).stdout;
  } catch (error) {
    if (error.code === 1 && Buffer.isBuffer(error.stdout)) bytes = error.stdout;
    else if (error.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER' || /maxBuffer/i.test(error.message)) throw new Error('Patch exceeds bound');
    else throw new Error(`git diff failed: ${(Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr || error.message)).slice(0, 2000)}`);
  }
  const decodedPatch = textBytes(bytes);
  if (decodedPatch !== null) {
    const cleaned = sanitize(decodedPatch, env, secrets);
    if (cleaned !== decodedPatch) reasons.add('patch_text_sanitized');
    bytes = Buffer.from(cleaned, 'utf8');
  } else {
    // A non-UTF-8 patch cannot be rewritten safely; its headers still carry
    // raw paths, so fail closed if the binary probe finds any current secret.
    const latin1 = bytes.toString('latin1'), utf8 = bytes.toString('utf8');
    if (sanitize(latin1, env, secrets) !== latin1 || sanitize(utf8, env, secrets) !== utf8) throw new Error('Patch contains secret-bearing non-UTF-8 content');
  }
  // Sanitization only ever grows the text (each match becomes `[redacted]`),
  // so the bound must be re-checked here, after the final sanitize, rather
  // than relying solely on git's own maxBuffer against the raw diff above.
  if (bytes.length > maxPatchBytes) throw new Error('Patch exceeds bound');
  const sorted = resolved.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  return { bytes, reasons, files: sorted, omittedPaths, droppedCount };
}
