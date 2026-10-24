import { spawn } from 'node:child_process';
import { processIdentity, stopOwnedGroup } from './ownership.mjs';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function evaluateVerification(before, after, commands, expectedCount) {
  if (!before.checkpointComplete) return { status: 'unverified', verifiedSnapshotDigest: null, reason: 'Pre-verification source snapshot incomplete' };
  if (!after.checkpointComplete || before.inputSnapshotDigest !== after.inputSnapshotDigest) return { status: 'mutated_or_incomplete', verifiedSnapshotDigest: null, reason: 'Verification changed source or post-verification snapshot is incomplete' };
  if (commands.length !== expectedCount) return { status: 'unverified', verifiedSnapshotDigest: null, reason: 'Not all selected commands ran' };
  const unsuccessful = commands.find(item => item.status !== 'passed');
  if (unsuccessful) return { status: unsuccessful.status, verifiedSnapshotDigest: null, reason: `Verifier ${unsuccessful.id} ${unsuccessful.status}` };
  return { status: 'passed', verifiedSnapshotDigest: after.inputSnapshotDigest };
}
export function reconcileFinalSnapshot(verification, manifest) {
  if (verification.status !== 'passed') return verification;
  if (manifest?.checkpointComplete && manifest.inputSnapshotDigest === verification.verifiedSnapshotDigest) return verification;
  return { ...verification, status: 'mutated_or_incomplete', verifiedSnapshotDigest: null, reason: 'Final source snapshot incomplete or differs from verified snapshot' };
}
async function assertPinnedExecutable(file) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file.split('/').some(part => part === '.' || part === '..')) throw new Error('Verifier executable path invalid');
  const real = await fs.realpath(file);
  if (!['/usr/bin', '/bin', '/usr/local/bin', '/opt/project-tools'].some(root => real.startsWith(root + '/'))) throw new Error('Verifier executable outside packaged roots');
  for (let current = real; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || current === real && (!stat.isFile() || (stat.mode & 0o111) === 0)) throw new Error('Verifier executable or ancestor is mutable');
    if (current === '/') break;
  }
  return real;
}
async function inspectProtectedFiles(files = []) {
  const records = [];
  for (const item of files) {
    if (!item.path.startsWith('/opt/project-tools/') || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('Invalid protected grader file declaration');
    let current = '/';
    for (const part of item.path.slice(1).split('/')) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022) throw new Error('Protected grader file or ancestor is mutable');
      if (current !== item.path && !stat.isDirectory()) throw new Error('Protected grader ancestor is not a directory');
      if (current === item.path && (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024)) throw new Error('Protected grader target is not a bounded regular file');
    }
    const handle = await fs.open(item.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== item.sha256 || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Protected grader file hash or identity mismatch');
      records.push({ path: item.path, sha256: digest, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs });
    } finally { await handle.close(); }
  }
  return records;
}
export async function runVerifier(command, { cwd, env, sanitize, onIdentity = async () => {}, cancelled = () => false }) {
  let executable, protectedBefore;
  try {
    executable = await assertPinnedExecutable(command.argv[0]);
    protectedBefore = await inspectProtectedFiles(command.protectedFiles);
  } catch {
    return { id: command.id, status: 'failed', reason: 'Verifier integrity preflight failed',
      trust: command.protectedFiles?.length ? 'declared_packaged_files' : 'repository_controlled_command', protectedFilesValid: false };
  }
  const started = Date.now();
  const runner = fileURLToPath(new URL('./verifier-runner.mjs', import.meta.url));
  const child = spawn(process.execPath, [runner, executable, ...command.argv.slice(1)], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const identity = await processIdentity(child.pid);
  await onIdentity(identity);
  try {
    await Promise.race([
      new Promise((resolve, reject) => { let ready = ''; child.stdio[3].on('data', chunk => { ready += chunk; if (ready === 'READY\n') resolve(); else if (ready.length > 16) reject(new Error('Verifier runner readiness invalid')); }); child.once('exit', () => reject(new Error('Verifier runner exited before readiness'))); }),
      delay(2000).then(() => { throw new Error('Verifier runner readiness timed out'); }),
    ]);
    child.stdin.end('RUN\n');
  } catch (error) { await stopOwnedGroup(identity, 100).catch(() => {}); throw error; }
  let stdout = [], stderr = [], stdoutBytes = 0, stderrBytes = 0, overflow = false;
  const collect = (where, chunk) => {
    if (where === 'stdout') stdoutBytes += chunk.length; else stderrBytes += chunk.length;
    if (stdoutBytes + stderrBytes > command.maxOutputBytes) { overflow = true; stdout = []; stderr = []; return; }
    if (!overflow) (where === 'stdout' ? stdout : stderr).push(chunk);
  };
  child.stdout.on('data', chunk => collect('stdout', chunk));
  child.stderr.on('data', chunk => collect('stderr', chunk));
  let exitCode = null, signal = null, timedOut = false, wasCancelled = false;
  const exited = new Promise(resolve => child.once('exit', (code, sig) => { exitCode = code; signal = sig; resolve(); }));
  const deadline = started + command.timeoutSeconds * 1000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline && !cancelled()) {
    await Promise.race([exited, delay(100)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    timedOut = Date.now() >= deadline; wasCancelled = !timedOut;
  }
  const stop = await stopOwnedGroup(identity, 500);
  if (stop.state !== 'stopped') return { id: command.id, status: 'quarantined', exitCode, signal, durationMs: Date.now() - started,
    timeout: timedOut, cancelled: wasCancelled, truncated: overflow, stdoutBytes, stderrBytes, stdout: '', stderr: '', ownership: stop.state };
  await Promise.race([closed, delay(1000)]);
  const protectedAfter = await inspectProtectedFiles(command.protectedFiles).catch(() => null);
  const protectedValid = protectedAfter && JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter);
  return { id: command.id, status: !protectedValid ? 'failed' : timedOut ? 'timed_out' : wasCancelled ? 'cancelled' : exitCode === 0 ? 'passed' : 'failed', exitCode, signal,
    trust: command.protectedFiles?.length ? 'declared_packaged_files' : 'repository_controlled_command', protectedFilesValid: !!protectedValid,
    durationMs: Date.now() - started, timeout: timedOut, cancelled: wasCancelled, truncated: overflow,
    stdoutBytes, stderrBytes, stdout: overflow ? '' : sanitize(Buffer.concat(stdout).toString('utf8')),
    stderr: overflow ? '' : sanitize(Buffer.concat(stderr).toString('utf8')) };
}
