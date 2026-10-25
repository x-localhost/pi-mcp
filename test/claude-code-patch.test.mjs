import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Manager } from '../src/manager.mjs';
import { snapshotArtifacts } from '../src/artifacts.mjs';
import { pagePatch } from '../src/patch.mjs';

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const exportPatchScript = fileURLToPath(new URL('../internal-agent/export-patch.mjs', import.meta.url));
const sha = buf => createHash('sha256').update(buf).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

async function writeFile(file, content, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (mode !== undefined) await fs.chmod(file, mode);
}

// A fresh repository/state fixture with a committed base, and a Manager that
// never spawns a worker so jobs can be driven and completed directly.
async function fixture(t, { childEnv = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-patch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  git(repository, 'init', '-q'); git(repository, 'config', 'user.email', 'test@example.invalid'); git(repository, 'config', 'user.name', 'Test');
  git(repository, 'config', 'core.fileMode', 'true');
  await writeFile(path.join(repository, 'base.txt'), 'base content\n');
  await writeFile(path.join(repository, 'deleted.txt'), 'remove me\n');
  await writeFile(path.join(repository, 'script.sh'), '#!/bin/sh\necho hi\n', 0o644);
  git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'base');
  const baseCommit = git(repository, 'rev-parse', 'HEAD');
  const stateDir = path.join(root, 'state');
  const config = { stateDir, allowedRoots: [root], maxConcurrent: 3, defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60,
    defaultMaxTurns: 2, piPath: fake, allowedCommands: [], provider: 'mock', model: 'mock', queue: { maxPending: 16, maxWaitSeconds: 3600 } };
  const manager = await new Manager(config, childEnv, { spawnWorker: false }).init();
  return { root, repository, baseCommit, stateDir, config, manager };
}

// Admits a job (worktree created, no worker spawned) through the raw manager.
async function admit(manager, repository, title = 'Task') {
  const started = await manager.start({ repository, title, prompt: 'Implement' });
  await manager.dispatchOnce();
  return manager.read(started.id);
}

// Snapshots the current worktree against baseCommit and marks the job
// completed with the resulting manifest, exactly as the real completion path
// would record on job.json, without needing a worker process.
async function finish(manager, job, { reports = [] } = {}) {
  const jobDir = manager.jobDir(job.id);
  const manifest = await snapshotArtifacts({ jobDir, worktree: job.worktree, baseCommit: job.baseCommit, config: manager.config.artifacts, env: manager.childEnv, reports });
  const completed = { ...job, status: 'completed', execution: { status: 'passed' },
    artifacts: { checkpointComplete: manifest.checkpointComplete, inputSnapshotDigest: manifest.inputSnapshotDigest, manifestSha256: manifest.manifestSha256 },
    finishedAt: new Date().toISOString() };
  await fs.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(completed));
  return { job: completed, manifest };
}

test('pi_patch round trip through the MCP client reproduces the checkpoint via git apply and leaves the user repository untouched', async t => {
  const { root, repository, baseCommit, stateDir, manager } = await fixture(t);
  const job = await admit(manager, repository);
  const wt = job.worktree;
  await writeFile(path.join(wt, 'base.txt'), 'modified content\n');
  await fs.rm(path.join(wt, 'deleted.txt'));
  await writeFile(path.join(wt, 'added.txt'), 'new file\n');
  await writeFile(path.join(wt, 'script.sh'), '#!/bin/sh\necho hi\n', 0o755);
  await writeFile(path.join(wt, 'with space', 'nested dir', 'café-日本語.txt'), 'nonascii content\n');
  await writeFile(path.join(wt, 'reports', 'x'), 'real source file under reports/\n');
  await writeFile(path.join(wt, 'images', 'pic.bin'), Buffer.from([0, 1, 2, 3, 255, 254, 0]));
  const { job: completed } = await finish(manager, job);

  const refsBefore = git(repository, 'for-each-ref');
  const headBefore = git(repository, 'rev-parse', 'HEAD');
  const objectsBefore = (await fs.readdir(path.join(repository, '.git', 'objects'))).sort();
  const indexBefore = await fs.readFile(path.join(repository, '.git', 'index'));

  const configFile = path.join(root, 'mcp-config.json');
  await fs.writeFile(configFile, JSON.stringify({ piPath: fake, stateDir, allowedRoots: [root], provider: 'mock', model: 'mock',
    maxConcurrent: 3, defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60, defaultMaxTurns: 2, allowedCommands: [] }));
  const client = new Client({ name: 'pi-mcp-patch-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, PI_MCP_CONFIG: configFile } });
  await client.connect(transport);
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  const payload = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  const meta = payload(await call('pi_patch', { job_id: completed.id, include_text: false }));
  assert.equal(meta.applicable, true);
  assert.deepEqual(meta.notApplicableReasons, []);
  assert.equal(meta.baseCommit, baseCommit);
  assert.equal(meta.encoding, 'utf8');
  assert.ok(meta.totalBytes > 0);
  assert.equal(meta.eof, true);
  assert.equal(meta.text, undefined);

  let offset = 0; const chunks = [];
  while (true) {
    const page = payload(await call('pi_patch', { job_id: completed.id, offset, max_bytes: 4096 }));
    chunks.push(page.encoding === 'base64' ? Buffer.from(page.text, 'base64') : Buffer.from(page.text, 'utf8'));
    offset = page.nextOffset;
    if (page.eof) break;
  }
  const patchBytes = Buffer.concat(chunks);
  assert.equal(sha(patchBytes), meta.sha256);
  assert.equal(patchBytes.length, meta.totalBytes);

  const fresh = path.join(root, 'fresh');
  git(root, 'clone', '-q', repository, fresh);
  git(fresh, 'checkout', '-q', baseCommit);
  const patchFile = path.join(root, 'round-trip.patch');
  await fs.writeFile(patchFile, patchBytes);
  execFileSync('git', ['-C', fresh, 'apply', '--check', patchFile]);
  execFileSync('git', ['-C', fresh, 'apply', patchFile]);

  assert.equal(await fs.readFile(path.join(fresh, 'base.txt'), 'utf8'), 'modified content\n');
  await assert.rejects(fs.access(path.join(fresh, 'deleted.txt')));
  assert.equal(await fs.readFile(path.join(fresh, 'added.txt'), 'utf8'), 'new file\n');
  assert.equal((await fs.stat(path.join(fresh, 'script.sh'))).mode & 0o777, 0o755);
  assert.equal(await fs.readFile(path.join(fresh, 'with space', 'nested dir', 'café-日本語.txt'), 'utf8'), 'nonascii content\n');
  assert.equal(await fs.readFile(path.join(fresh, 'reports', 'x'), 'utf8'), 'real source file under reports/\n');
  assert.deepEqual(await fs.readFile(path.join(fresh, 'images', 'pic.bin')), Buffer.from([0, 1, 2, 3, 255, 254, 0]));

  assert.equal(git(repository, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(repository, 'for-each-ref'), refsBefore);
  assert.deepEqual((await fs.readdir(path.join(repository, '.git', 'objects'))).sort(), objectsBefore);
  assert.deepEqual(await fs.readFile(path.join(repository, '.git', 'index')), indexBefore);

  const byPath = Object.fromEntries(meta.files.map(f => [f.path, f]));
  assert.equal(byPath['added.txt'].change, 'added');
  assert.equal(byPath['deleted.txt'].change, 'deleted');
  assert.equal(byPath['base.txt'].change, 'modified');
  assert.equal(byPath['script.sh'].change, 'mode');
  assert.equal(byPath['images/pic.bin'].binary, true);
  assert.equal(byPath['with space/nested dir/café-日本語.txt'].change, 'added');
  assert.equal(meta.filesTruncated, false);
  assert.deepEqual(meta.omittedPaths, []);
});

test('an empty change set produces an applicable, zero-byte patch', async t => {
  const { repository, manager } = await fixture(t);
  const job = await admit(manager, repository);
  const { job: completed } = await finish(manager, job);
  const page = await manager.patch(completed.id);
  assert.equal(page.applicable, true);
  assert.equal(page.totalBytes, 0);
  assert.equal(page.sha256, sha(Buffer.alloc(0)));
  assert.deepEqual(page.files, []);
  assert.equal(page.eof, true);
  assert.equal(page.text, '');
});

test('pagePatch pages utf8 text at newline or character boundaries, falls back to base64 for non-text, and rejects invalid offsets', () => {
  const longLine = 'x'.repeat(10) + '日'.repeat(2000);
  const text = `first\n${longLine}\nlast\n`;
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0; const collected = [];
  for (let guard = 0; guard < 100; guard++) {
    const page = pagePatch(bytes, offset, 4096);
    assert.equal(page.encoding, 'utf8');
    collected.push(page.text);
    assert.equal(Buffer.byteLength(page.text, 'utf8'), page.nextOffset - offset);
    offset = page.nextOffset;
    if (page.eof) break;
  }
  assert.equal(collected.join(''), text);
  assert.throws(() => pagePatch(bytes, bytes.length + 1, 4096), /offset/i);
  // byte 16 is the lead byte of the first multi-byte character in longLine; 17 is a continuation byte.
  assert.equal(bytes.slice(6, 16).toString('utf8'), 'x'.repeat(10));
  assert.throws(() => pagePatch(bytes, 17, 4096), /character boundary/i);
  assert.equal(pagePatch(bytes, bytes.length, 4096).text, '');

  const binary = Buffer.concat([Buffer.from([0]), Buffer.alloc(9000, 7)]);
  let boffset = 0; const bchunks = [];
  for (let guard = 0; guard < 100; guard++) {
    const page = pagePatch(binary, boffset, 4096);
    assert.equal(page.encoding, 'base64');
    bchunks.push(Buffer.from(page.text, 'base64'));
    boffset = page.nextOffset;
    if (page.eof) break;
  }
  assert.deepEqual(Buffer.concat(bchunks), binary);
  assert.throws(() => pagePatch(binary, binary.length + 1, 4096), /offset/i);
});

test('include_text false returns metadata only and matches a text call at the same offset', async t => {
  const { repository, manager } = await fixture(t);
  const job = await admit(manager, repository);
  await writeFile(path.join(job.worktree, 'base.txt'), 'changed\n');
  const { job: completed } = await finish(manager, job);
  const metaOnly = await manager.patch(completed.id, { include_text: false });
  assert.equal('text' in metaOnly, false);
  const withText = await manager.patch(completed.id, { include_text: true });
  assert.equal(metaOnly.nextOffset, withText.nextOffset);
  assert.equal(metaOnly.eof, withText.eof);
  assert.equal(metaOnly.encoding, withText.encoding);
  assert.equal(metaOnly.sha256, withText.sha256);
  assert.ok(withText.text.length > 0);
});

test('a secret in base-only (deleted) content is sanitized and marks the patch not applicable', async t => {
  const { repository, manager } = await fixture(t, { childEnv: { API_TOKEN: 'super-secret-value-123' } });
  await writeFile(path.join(repository, 'secret.txt'), 'keep\nsuper-secret-value-123\nkeep2\n');
  git(repository, 'add', 'secret.txt'); git(repository, 'commit', '-qm', 'secret');
  const job = await admit(manager, repository);
  await writeFile(path.join(job.worktree, 'secret.txt'), 'keep\nkeep2\n');
  const { job: completed } = await finish(manager, job);
  const page = await manager.patch(completed.id);
  assert.equal(page.applicable, false);
  assert.ok(page.notApplicableReasons.includes('base_text_sanitized'));
  assert.doesNotMatch(page.text, /super-secret-value-123/);
  assert.match(page.text, /\[redacted\]/);
  assert.equal(page.files.find(f => f.path === 'secret.txt').change, 'modified');
});

test('a secret-bearing base binary is left out of the patch entirely', async t => {
  const { repository, manager } = await fixture(t, { childEnv: { API_TOKEN: 'super-secret-value-456' } });
  await fs.writeFile(path.join(repository, 'secret.bin'), Buffer.concat([Buffer.from([0]), Buffer.from('super-secret-value-456')]));
  git(repository, 'add', 'secret.bin'); git(repository, 'commit', '-qm', 'secret binary');
  const job = await admit(manager, repository);
  await fs.writeFile(path.join(job.worktree, 'secret.bin'), Buffer.concat([Buffer.from([0]), Buffer.from('harmless replacement')]));
  const { job: completed } = await finish(manager, job);
  const page = await manager.patch(completed.id);
  assert.equal(page.applicable, false);
  assert.ok(page.notApplicableReasons.includes('secret_bearing_base_binary'));
  assert.equal(page.files.some(f => f.path === 'secret.bin'), false);
  assert.doesNotMatch(page.text, /super-secret-value-456/);
});

test('a real omission without a manifest entry makes the patch not applicable and is listed', async t => {
  const { repository, manager } = await fixture(t);
  const job = await admit(manager, repository);
  await writeFile(path.join(job.worktree, 'big.txt'), 'x'.repeat(5000));
  const jobDir = manager.jobDir(job.id);
  const manifest = await snapshotArtifacts({ jobDir, worktree: job.worktree, baseCommit: job.baseCommit, config: { maxFileBytes: 10, maxTotalBytes: 100000, maxFiles: 256, maxReadBytes: 10 }, env: manager.childEnv });
  assert.equal(manifest.omissions.some(o => o.path === 'big.txt'), true);
  const completed = { ...job, status: 'completed', execution: { status: 'passed' },
    artifacts: { checkpointComplete: manifest.checkpointComplete, inputSnapshotDigest: manifest.inputSnapshotDigest, manifestSha256: manifest.manifestSha256 } };
  await fs.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(completed));
  const page = await manager.patch(completed.id);
  assert.equal(page.applicable, false);
  assert.ok(page.notApplicableReasons.includes('export_incomplete'));
  assert.ok(page.omittedPaths.includes('big.txt'));
  assert.equal(page.files.some(f => f.path === 'big.txt'), false);
});

test('an unsafe base ancestor (a symlink hiding a deeper added path) is refused rather than treated as a plain addition', async t => {
  const { root, repository, manager } = await fixture(t);
  await fs.symlink('base.txt', path.join(repository, 'link'));
  git(repository, 'add', 'link'); git(repository, 'commit', '-qm', 'symlink');
  const baseCommit = git(repository, 'rev-parse', 'HEAD');
  const job = await admit(manager, repository);
  assert.equal(job.baseCommit, baseCommit);
  await fs.rm(path.join(job.worktree, 'link'));
  await writeFile(path.join(job.worktree, 'link', 'inner.txt'), 'nested under former symlink\n');
  const { job: completed } = await finish(manager, job);
  const page = await manager.patch(completed.id);
  assert.equal(page.applicable, false);
  assert.ok(page.notApplicableReasons.includes('unsupported_base'));
  // The symlink's own removal is caught even earlier, as an unsafe_file_type
  // omission at snapshot time (the worktree no longer has a regular file
  // there at all), which independently also makes the manifest incomplete.
  assert.ok(page.omittedPaths.includes('link'));
  assert.equal(page.files.some(f => f.path === 'link/inner.txt'), false);
});

test('an oversized base deletion is left out and marks the patch not applicable', async t => {
  const { repository, manager } = await fixture(t);
  await writeFile(path.join(repository, 'large.txt'), 'y'.repeat(5000));
  git(repository, 'add', 'large.txt'); git(repository, 'commit', '-qm', 'large base file');
  const job = await admit(manager, repository);
  await fs.rm(path.join(job.worktree, 'large.txt'));
  const { job: completed } = await finish(manager, job);
  manager.config.artifacts = { maxFiles: 256, maxFileBytes: 100, maxTotalBytes: 100000, maxReadBytes: 100 };
  const page = await manager.patch(completed.id);
  assert.equal(page.applicable, false);
  assert.ok(page.notApplicableReasons.includes('oversized_base'));
  assert.equal(page.files.some(f => f.path === 'large.txt'), false);
});

test('a non-terminal job and a quarantined job are both refused', async t => {
  const { repository, manager } = await fixture(t);
  const job = await admit(manager, repository);
  await assert.rejects(manager.patch(job.id), /terminal/i);
  const quarantined = { ...job, status: 'quarantined' };
  await fs.writeFile(path.join(manager.jobDir(job.id), 'job.json'), JSON.stringify(quarantined));
  await assert.rejects(manager.patch(job.id), /quarantined/i);
});

test('the cache is reused across calls without rewriting the cached patch file', async t => {
  const { repository, manager } = await fixture(t);
  const job = await admit(manager, repository);
  await writeFile(path.join(job.worktree, 'base.txt'), 'changed once\n');
  const { job: completed } = await finish(manager, job);
  const first = await manager.patch(completed.id);
  const statBefore = await fs.stat(first.patchFile);
  const second = await manager.patch(completed.id);
  const statAfter = await fs.stat(second.patchFile);
  assert.equal(second.sha256, first.sha256);
  assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
  assert.equal(statAfter.ctimeMs, statBefore.ctimeMs);
});

test('a tampered patch.json or cached patch file is detected and rebuilt correctly', async t => {
  const { repository, manager } = await fixture(t);
  const job = await admit(manager, repository);
  await writeFile(path.join(job.worktree, 'base.txt'), 'changed for tamper test\n');
  const { job: completed } = await finish(manager, job);
  const first = await manager.patch(completed.id);
  const dir = path.join(manager.jobDir(completed.id), 'patch');

  await fs.writeFile(path.join(dir, 'patch.json'), 'not json');
  const afterDescriptorTamper = await manager.patch(completed.id);
  assert.equal(afterDescriptorTamper.sha256, first.sha256);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'patch.json'), 'utf8')).sha256, first.sha256);

  const patchFile = first.patchFile;
  const corrupted = Buffer.concat([await fs.readFile(patchFile), Buffer.from('tampered')]);
  await fs.writeFile(patchFile, corrupted);
  const afterFileTamper = await manager.patch(completed.id);
  assert.equal(afterFileTamper.sha256, first.sha256);
  assert.equal(sha(await fs.readFile(patchFile)), first.sha256);
});

test('concurrent generation from two manager instances converges on the same patch without error', async t => {
  const { repository, manager, config } = await fixture(t);
  const job = await admit(manager, repository);
  await writeFile(path.join(job.worktree, 'base.txt'), 'changed concurrently\n');
  const { job: completed } = await finish(manager, job);
  const other = await new Manager({ ...config }, {}, { spawnWorker: false }).init();
  const [a, b] = await Promise.all([manager.patch(completed.id), other.patch(completed.id)]);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.totalBytes, b.totalBytes);
  const again = await manager.patch(completed.id);
  assert.equal(again.sha256, a.sha256);
});

test('pi_cleanup never recreates a removed job directory, before or after a patch was built', async t => {
  const { repository, manager } = await fixture(t);
  const before = await admit(manager, repository);
  const { job: completedBefore } = await finish(manager, before);
  await manager.cleanup({ job_ids: [completedBefore.id], dry_run: false });
  await assert.rejects(manager.patch(completedBefore.id), /not found/i);
  await assert.rejects(fs.access(manager.jobDir(completedBefore.id)));

  const after = await admit(manager, repository, 'Second');
  await writeFile(path.join(after.worktree, 'base.txt'), 'changed\n');
  const { job: completedAfter } = await finish(manager, after);
  await manager.patch(completedAfter.id);
  await manager.cleanup({ job_ids: [completedAfter.id], dry_run: false });
  await assert.rejects(manager.patch(completedAfter.id), /not found/i);
  await assert.rejects(fs.access(manager.jobDir(completedAfter.id)));
});

test('a followup does not change the earlier job patch', async t => {
  const { repository, manager } = await fixture(t);
  const first = await admit(manager, repository);
  await writeFile(path.join(first.worktree, 'base.txt'), 'first change\n');
  const { job: completedFirst } = await finish(manager, first);
  const firstPatch = await manager.patch(completedFirst.id);

  const followupStart = await manager.start({ prompt: 'continue' }, completedFirst.id);
  await manager.dispatchOnce();
  const followup = await manager.read(followupStart.id);
  assert.equal(followup.worktree, completedFirst.worktree);
  await writeFile(path.join(followup.worktree, 'base.txt'), 'second change on top\n');
  const { job: completedFollowup } = await finish(manager, followup);

  const firstPatchAgain = await manager.patch(completedFirst.id);
  assert.equal(firstPatchAgain.sha256, firstPatch.sha256);
  assert.match(firstPatchAgain.text, /first change/);

  const followupPatch = await manager.patch(completedFollowup.id);
  assert.notEqual(followupPatch.sha256, firstPatch.sha256);
  assert.match(followupPatch.text, /second change on top/);
});

test('export-patch.mjs refuses a missing or malformed job id before touching the sandbox', () => {
  for (const args of [[], ['not-a-job-id'], ['task-short']]) {
    const result = spawnSync(process.execPath, [exportPatchScript, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: export-patch\.mjs/);
  }
});

test('export-patch.mjs builds via manager.patch, verifies the cache with no-follow helpers, and never sets exportedAt', async () => {
  const source = await fs.readFile(exportPatchScript, 'utf8');
  assert.match(source, /manager\.patch\(/);
  assert.match(source, /include_text:\s*false/);
  assert.match(source, /safeLstat/);
  assert.match(source, /readRegular/);
  assert.match(source, /descriptor\.sha256/);
  assert.match(source, /descriptor\.totalBytes/);
  assert.doesNotMatch(source, /exportedAt/);
});

test('a different secret-named child env value changes the cache key and is masked in the patch', async t => {
  const { repository, manager, config } = await fixture(t);
  const job = await admit(manager, repository);
  await writeFile(path.join(job.worktree, 'base.txt'), 'uses rotated-token-value-123\n');
  const { job: completed } = await finish(manager, job);
  const plain = await manager.patch(completed.id);
  assert.match(plain.text, /rotated-token-value-123/);
  const masked = await new Manager({ ...config }, { CORP_API_TOKEN: 'rotated-token-value-123' }, { spawnWorker: false }).init();
  const rotated = await masked.patch(completed.id);
  assert.notEqual(rotated.patchFile, plain.patchFile);
  assert.doesNotMatch(rotated.text, /rotated-token-value-123/);
  assert.equal(rotated.applicable, false);
});
