import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const validIdentity = record => record && Number.isSafeInteger(record.pid) && record.pid > 0 && Number.isSafeInteger(record.pgid) && record.pgid > 0 &&
  /^[0-9a-f-]{36}$/.test(record.bootId || '') && /^pid:\[\d+\]$/.test(record.pidNamespace || '') && /^\d+$/.test(record.startTicks || '');
export async function processIdentity(pid = process.pid, procRoot = '/proc') {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('Linux process identity unavailable');
  const [bootId, pidNamespace, statLine] = await Promise.all([
    fs.readFile(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8'), fs.readlink(path.join(procRoot, String(pid), 'ns/pid')), fs.readFile(path.join(procRoot, String(pid), 'stat'), 'utf8'),
  ]);
  const end = statLine.lastIndexOf(')');
  if (end < 0) throw new Error('Invalid Linux process stat');
  const fields = statLine.slice(end + 2).trim().split(/\s+/);
  const pgid = Number(fields[2]); const startTicks = fields[19];
  if (!Number.isSafeInteger(pgid) || !/^\d+$/.test(startTicks)) throw new Error('Invalid Linux process identity');
  return { pid, bootId: bootId.trim(), pidNamespace, startTicks, pgid, state: fields[0] };
}
export async function identityState(record, { procRoot = '/proc' } = {}) {
  if (!validIdentity(record)) return 'unknown';
  if (process.platform !== 'linux') return 'unknown';
  const bootId = (await fs.readFile(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim();
  if (bootId !== record.bootId) return 'gone';
  const observed = await processIdentity(record.pid, procRoot).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!observed) return 'gone';
  return observed.pidNamespace === record.pidNamespace && observed.startTicks === record.startTicks && observed.pgid === record.pgid ? 'same' : 'gone';
}
export async function groupState(record, { procRoot = '/proc' } = {}) {
  if (process.platform !== 'linux' || !validIdentity(record)) return { state: 'ambiguous', members: [] };
  const self = await processIdentity(process.pid, procRoot).catch(() => null);
  if (!self) return { state: 'ambiguous', members: [] };
  if (self.bootId !== record.bootId) return { state: 'stopped', members: [] };
  if (self.pidNamespace !== record.pidNamespace) return { state: 'ambiguous', members: [] };
  const leader = await identityState(record, { procRoot }).catch(() => 'unknown');
  const names = await fs.readdir(procRoot).catch(() => null);
  if (!names) return { state: 'ambiguous', members: [] };
  const members = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const statFile = path.join(procRoot, name, 'stat');
    let statLine;
    try { statLine = await fs.readFile(statFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; return { state: 'ambiguous', members }; }
    const end = statLine.lastIndexOf(')');
    if (end < 0) return { state: 'ambiguous', members };
    const fields = statLine.slice(end + 2).trim().split(/\s+/);
    const pgid = Number(fields[2]);
    if (!Number.isSafeInteger(pgid)) return { state: 'ambiguous', members };
    // /proc/<pid>/stat is generally readable even when another user's
    // namespace link is not. Inspect namespace/start identity only for
    // candidate members of this exact process group.
    if (pgid !== record.pgid || fields[0] === 'Z') continue;
    let item;
    try { item = await processIdentity(Number(name), procRoot); }
    catch (error) {
      if ((error.code === 'ENOENT' || error.code === 'ESRCH') && !await fs.access(statFile).then(() => true, () => false)) continue;
      return { state: 'ambiguous', members };
    }
    if (item && item.bootId === record.bootId && item.pidNamespace === record.pidNamespace && item.pgid === record.pgid && item.state !== 'Z') members.push(item.pid);
  }
  const leaderAfter = await identityState(record, { procRoot }).catch(() => 'unknown');
  if (!members.length) return { state: 'stopped', members: [] };
  if (leader !== leaderAfter) return { state: 'ambiguous', members };
  if (leader !== 'same') return { state: 'ambiguous', members };
  return { state: 'owned', members };
}
export async function stopOwnedGroup(record, graceMs = 1500) {
  const before = await groupState(record);
  if (before.state === 'stopped') return { state: 'stopped', before };
  if (before.state !== 'owned' || record.pgid !== record.pid) return { state: 'ambiguous', before };
  if (await identityState(record) !== 'same') return { state: 'ambiguous', before };
  process.kill(-record.pgid, 'SIGTERM'); await delay(graceMs);
  let after = await groupState(record);
  if (after.state === 'owned') {
    if (await identityState(record) !== 'same') return { state: 'ambiguous', before, after };
    process.kill(-record.pgid, 'SIGKILL'); await delay(500); after = await groupState(record);
  }
  return { state: after.state, before, after };
}
export async function withOwnershipLock(lockFile, run, { timeoutSeconds = 10 } = {}) {
  if (process.platform !== 'linux') throw new Error('Kernel ownership lock requires Linux');
  const owner = { nonce: randomUUID(), acquiredAt: new Date().toISOString(), identity: await processIdentity() };
  const temporary = path.join(path.dirname(lockFile), `.${path.basename(lockFile)}.${owner.nonce}.owner`);
  await fs.writeFile(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  const args = timeoutSeconds === 0 ? ['-x', '-n', lockFile, 'sh', '-c', 'printf "READY\\n"; cat >/dev/null'] : ['-x', '-w', String(timeoutSeconds), lockFile, 'sh', '-c', 'printf "READY\\n"; cat >/dev/null'];
  const child = spawn('/usr/bin/flock', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  let acquired = false;
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('READY\n')) { acquired = true; resolve(); } });
      child.once('error', reject);
      child.once('exit', code => { if (!acquired) reject(new Error(code === 1 ? 'Ownership lock busy' : `Ownership lock failed (${code})`)); });
    });
    await fs.rename(temporary, `${lockFile}.owner.json`);
    return await run();
  } finally {
    if (acquired) await fs.rm(`${lockFile}.owner.json`, { force: true }).catch(() => {});
    else await fs.rm(temporary, { force: true }).catch(() => {});
    child.stdin.end();
    await closed;
  }
}
