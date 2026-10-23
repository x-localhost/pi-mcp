import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { snapshotArtifacts, listArtifacts, readArtifact, restoreCheckpoint, validateArtifactConfig, exportArtifactBundle } from '../src/artifacts.mjs';
import { packMaterial, validateOfflineConfig, applyOfflineMaterials } from '../src/offline-materials.mjs';

const hash = x => createHash('sha256').update(x).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-artifacts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); const jobDir = path.join(root, 'job');
  await fs.mkdir(repo); await fs.mkdir(jobDir);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'test@example.test'); git(repo, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, 'changed.txt'), 'old\n');
  await fs.writeFile(path.join(repo, 'deleted.txt'), 'remove me\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  return { root, repo, jobDir, baseCommit: git(repo, 'rev-parse', 'HEAD') };
}

test('private checkpoint restores changed, deleted, new and executable files; public export redacts', async t => {
  const { root, repo, jobDir, baseCommit } = await fixture(t);
  await fs.writeFile(path.join(repo, 'changed.txt'), 'Bearer secret-token\n');
  await fs.rm(path.join(repo, 'deleted.txt'));
  await fs.writeFile(path.join(repo, 'new.sh'), '#!/bin/sh\necho hello\n', { mode: 0o755 });
  const manifest = await snapshotArtifacts({ jobDir, worktree: repo, baseCommit, config: validateArtifactConfig({}), env: { API_TOKEN: 'secret-token' } });
  assert.equal(manifest.checkpointComplete, true);
  assert.equal(manifest.exportComplete, false);
  const page = await listArtifacts(jobDir, { limit: 1 });
  assert.equal(page.entries.length, 1); assert.ok(page.nextCursor);
  const pages = [page]; let cursor = page.nextCursor;
  while (cursor) { const next = await listArtifacts(jobDir, { cursor, limit: 1 }); pages.push(next); cursor = next.nextCursor; }
  const entries = pages.flatMap(p => p.entries);
  const changed = entries.find(e => e.path === 'changed.txt');
  assert.equal(changed.redacted, true);
  const data = await readArtifact(jobDir, { artifact_id: changed.id, offset: 0, length: 4096 });
  assert.equal(Buffer.from(data.data_base64, 'base64').toString(), 'Bearer [redacted]\n');
  assert.equal(data.sha256, hash(Buffer.from('Bearer [redacted]\n')));
  await fs.writeFile(path.join(repo, 'changed.txt'), 'later followup\n');
  const fresh = path.join(root, 'fresh'); git(root, 'clone', '-q', repo, fresh); git(fresh, 'checkout', '-q', baseCommit);
  const restored = await restoreCheckpoint({ jobDir, worktree: fresh });
  assert.equal(restored.restored, 3);
  assert.equal(await fs.readFile(path.join(fresh, 'changed.txt'), 'utf8'), 'Bearer secret-token\n');
  await assert.rejects(fs.access(path.join(fresh, 'deleted.txt')));
  assert.equal((await fs.stat(path.join(fresh, 'new.sh'))).mode & 0o777, 0o755);
});

test('snapshot rejects symlinks and incomplete checkpoint cannot restore', async t => {
  const { root, repo, jobDir, baseCommit } = await fixture(t);
  await fs.symlink('/etc/passwd', path.join(repo, 'link'));
  const manifest = await snapshotArtifacts({ jobDir, worktree: repo, baseCommit, config: validateArtifactConfig({}) });
  assert.equal(manifest.checkpointComplete, false);
  assert.ok(manifest.omissions.some(x => x.path === 'link'));
  const fresh = path.join(root, 'fresh'); git(root, 'clone', '-q', repo, fresh);
  await assert.rejects(restoreCheckpoint({ jobDir, worktree: fresh }), /incomplete/i);
});

test('offline material pack applies pinned dependency and rejects hash/path/collision before mutation', async t => {
  const { root, repo, baseCommit } = await fixture(t);
  const source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'dep.js'), 'module.exports = 42;\n');
  const bundle = await packMaterial({ sourceDir: source, sourceCommit: baseCommit });
  const manifestPath = path.join(root, 'dep.material.json'); await fs.writeFile(manifestPath, bundle);
  const config = validateOfflineConfig({ materials: [{ id: 'dep', manifestPath, manifestSha256: hash(bundle), baseCommit, destination: 'vendor' }] }, root);
  const applied = await applyOfflineMaterials({ worktree: repo, baseCommit, selections: ['dep'], config });
  assert.equal(applied.materials[0].id, 'dep');
  assert.equal(execFileSync('node', ['-e', "if(require('./vendor/dep.js')!==42)process.exit(1)"], { cwd: repo }).length, 0);
  await assert.rejects(applyOfflineMaterials({ worktree: repo, baseCommit, selections: ['dep'], config }), /collision/i);
  const bad = JSON.parse(bundle); bad.entries[0].path = '../escape';
  const badBytes = Buffer.from(JSON.stringify(bad)); await fs.writeFile(manifestPath, badBytes);
  const badConfig = validateOfflineConfig({ materials: [{ id: 'dep', manifestPath, manifestSha256: hash(badBytes), baseCommit, destination: 'other' }] }, root);
  await assert.rejects(applyOfflineMaterials({ worktree: repo, baseCommit, selections: ['dep'], config: badConfig }), /path/i);
  await assert.rejects(fs.access(path.join(repo, 'other')));
});

test('large safe binary pages reconstruct exact bytes; secret binary omitted; reports sanitize', async t => {
  const { repo, jobDir, baseCommit } = await fixture(t);
  const large = Buffer.alloc(1200 * 1024, 0x80); large[0] = 0;
  await fs.writeFile(path.join(repo, 'large.bin'), large);
  await fs.writeFile(path.join(repo, 'secret.bin'), Buffer.concat([Buffer.from([0]), Buffer.from('secret-token')]));
  await fs.writeFile(path.join(repo, 'unicode.bin'), Buffer.concat([Buffer.from([0xff]), Buffer.from('SÉCRET')]));
  await fs.writeFile(path.join(jobDir, 'result.json'), '{"message":"Bearer secret-token"}\n');
  const manifest = await snapshotArtifacts({ jobDir, worktree: repo, baseCommit, config: validateArtifactConfig({ maxFileBytes: 2 * 1024 * 1024 }), env: { API_TOKEN: 'secret-token', OTHER_SECRET: 'SÉCRET' }, reports: [{ name: 'result', file: 'result.json' }] });
  const binary = manifest.entries.find(x => x.path === 'large.bin');
  assert.equal(binary.encoding, 'base64'); assert.equal(binary.sha256, hash(large));
  const chunks = []; let offset = 0;
  do { const page = await readArtifact(jobDir, { artifact_id: binary.id, offset, length: 65536 }); chunks.push(Buffer.from(page.data_base64, 'base64')); offset = page.nextOffset; if (page.eof) break; } while (true);
  assert.deepEqual(Buffer.concat(chunks), large);
  assert.equal(manifest.entries.find(x => x.path === 'secret.bin').omittedReason, 'secret_bearing_binary');
  assert.equal(manifest.entries.find(x => x.path === 'unicode.bin').omittedReason, 'secret_bearing_binary');
  const report = manifest.entries.find(x => x.path === 'reports/result');
  assert.equal(report.redacted, true);
  const bundle = await exportArtifactBundle(jobDir);
  assert.equal(bundle.blobs[binary.id], large.toString('base64'));
  assert.equal(Object.keys(bundle.blobs).includes(manifest.entries.find(x => x.path === 'secret.bin').id), false);
});

test('snapshot marks same-path mutation and bounds omitted files; unsafe policy path rejects', async t => {
  const { repo, jobDir, baseCommit } = await fixture(t);
  await fs.writeFile(path.join(repo, 'changed.txt'), 'new text\n');
  await fs.writeFile(path.join(repo, 'extra.txt'), 'extra\n');
  const manifest = await snapshotArtifacts({ jobDir, worktree: repo, baseCommit, config: validateArtifactConfig({ maxFiles: 1 }), sanitize: value => {
    if (value === 'new text\n') writeFileSync(path.join(repo, 'changed.txt'), 'new more\n');
    return value;
  } });
  assert.equal(manifest.checkpointComplete, false);
  assert.ok(manifest.omissions.some(x => x.reason === 'mutated_after_capture'));
  assert.ok(manifest.omissions.some(x => x.reason === 'file_count_limit'));
  const more = path.join(path.dirname(jobDir), 'job-more'); await fs.mkdir(more);
  await fs.writeFile(path.join(repo, '.Pi-McP-Policy'), 'bad');
  const unsafe = await snapshotArtifacts({ jobDir: more, worktree: repo, baseCommit });
  assert.equal(unsafe.checkpointComplete, false);
  assert.ok(unsafe.omissions.some(x => x.reason === 'unsafe_path'));
});

test('pinned LFS overlay excludes imported baseline, restores later model edit, and rejects wrong original hash', async t => {
  const { root, repo, jobDir } = await fixture(t);
  await fs.mkdir(path.join(repo, 'assets'));
  await fs.writeFile(path.join(repo, 'assets', 'model.bin'), 'version https://git-lfs.github.com/spec/v1\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'lfs pointer');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  const source = path.join(root, 'real'); const original = path.join(root, 'pointer');
  await fs.mkdir(source); await fs.mkdir(original);
  await fs.writeFile(path.join(source, 'model.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(original, 'model.bin'), 'version https://git-lfs.github.com/spec/v1\n');
  const bundle = await packMaterial({ sourceDir: source, sourceCommit: baseCommit, expectedOriginalDir: original });
  const manifestPath = path.join(root, 'lfs.json'); await fs.writeFile(manifestPath, bundle);
  const config = validateOfflineConfig({ materials: [{ id: 'lfs', manifestPath, manifestSha256: hash(bundle), baseCommit, destination: 'assets', collision: 'overlay-lfs' }] }, root);
  const applied = await applyOfflineMaterials({ worktree: repo, baseCommit, selections: ['lfs'], config });
  const cleanJob = path.join(root, 'clean-job'); await fs.mkdir(cleanJob);
  const clean = await snapshotArtifacts({ jobDir: cleanJob, worktree: repo, baseCommit, materialBaseline: applied.materialBaseline, inputMaterialsDigest: applied.inputMaterialsDigest });
  assert.equal(clean.entries.length, 0);
  await fs.writeFile(path.join(repo, 'assets', 'model.bin'), Buffer.from([0, 5, 6]));
  const changed = await snapshotArtifacts({ jobDir, worktree: repo, baseCommit, materialBaseline: applied.materialBaseline, inputMaterialsDigest: applied.inputMaterialsDigest });
  assert.equal(changed.entries.length, 1);
  const fresh = path.join(root, 'fresh'); git(root, 'clone', '-q', repo, fresh); git(fresh, 'checkout', '-q', baseCommit);
  await applyOfflineMaterials({ worktree: fresh, baseCommit, selections: ['lfs'], config });
  await restoreCheckpoint({ jobDir, worktree: fresh });
  assert.deepEqual(await fs.readFile(path.join(fresh, 'assets', 'model.bin')), Buffer.from([0, 5, 6]));
  await fs.writeFile(path.join(original, 'model.bin'), 'wrong');
  const wrongBundle = await packMaterial({ sourceDir: source, sourceCommit: baseCommit, expectedOriginalDir: original });
  const wrongPath = path.join(root, 'wrong.json'); await fs.writeFile(wrongPath, wrongBundle);
  const wrongConfig = validateOfflineConfig({ materials: [{ id: 'wrong', manifestPath: wrongPath, manifestSha256: hash(wrongBundle), baseCommit, destination: 'assets', collision: 'overlay-lfs' }] }, root);
  const another = path.join(root, 'another'); git(root, 'clone', '-q', repo, another); git(another, 'checkout', '-q', baseCommit);
  await assert.rejects(applyOfflineMaterials({ worktree: another, baseCommit, selections: ['wrong'], config: wrongConfig }), /original hash mismatch/);
  assert.equal(await fs.readFile(path.join(another, 'assets', 'model.bin'), 'utf8'), 'version https://git-lfs.github.com/spec/v1\n');
});

test('flattened submodule files require pinned gitlink', async t => {
  const { root, repo } = await fixture(t);
  const gitlink = 'a'.repeat(40);
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${gitlink},third_party`);
  git(repo, 'commit', '-qm', 'gitlink');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  const source = path.join(root, 'submodule-files'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'lib.js'), 'module.exports = 7;\n');
  const bundle = await packMaterial({ sourceDir: source, sourceCommit: baseCommit });
  const manifestPath = path.join(root, 'submodule.json'); await fs.writeFile(manifestPath, bundle);
  const config = validateOfflineConfig({ materials: [{ id: 'sub', manifestPath, manifestSha256: hash(bundle), baseCommit, destination: 'third_party', collision: 'submodule', submoduleCommit: gitlink }] }, root);
  const result = await applyOfflineMaterials({ worktree: repo, baseCommit, selections: ['sub'], config });
  assert.equal(result.materialBaseline[0].path, 'third_party/lib.js');
  assert.equal(await fs.readFile(path.join(repo, 'third_party', 'lib.js'), 'utf8'), 'module.exports = 7;\n');
});

test('rename is represented as delete plus new bytes and private blob tampering blocks restore', async t => {
  const { root, repo, jobDir, baseCommit } = await fixture(t);
  await fs.rename(path.join(repo, 'deleted.txt'), path.join(repo, 'renamed.txt'));
  const manifest = await snapshotArtifacts({ jobDir, worktree: repo, baseCommit });
  assert.equal(manifest.entries.find(x => x.path === 'deleted.txt').type, 'delete');
  assert.equal(manifest.entries.find(x => x.path === 'renamed.txt').type, 'file');
  const id = manifest.entries.find(x => x.path === 'renamed.txt').id;
  const raw = path.join(jobDir, 'artifacts', 'private', id);
  await fs.rm(raw); await fs.symlink('/etc/passwd', raw);
  const fresh = path.join(root, 'fresh'); git(root, 'clone', '-q', repo, fresh);
  await assert.rejects(restoreCheckpoint({ jobDir, worktree: fresh }), /Symlink|Unsafe|ELOOP/);
  assert.equal(await fs.readFile(path.join(fresh, 'deleted.txt'), 'utf8'), 'remove me\n');
});

test('public blob symlink blocks read and export; two-material collision does not partly apply', async t => {
  const { root, repo, jobDir, baseCommit } = await fixture(t);
  await fs.writeFile(path.join(repo, 'changed.txt'), 'different');
  const manifest = await snapshotArtifacts({ jobDir, worktree: repo, baseCommit });
  const id = manifest.entries.find(x => x.path === 'changed.txt').id;
  const publicBlob = path.join(jobDir, 'artifacts', 'public', id);
  await fs.rm(publicBlob); await fs.symlink('/etc/passwd', publicBlob);
  await assert.rejects(readArtifact(jobDir, { artifact_id: id }), /Symlink|Unsafe|ELOOP/);
  await assert.rejects(exportArtifactBundle(jobDir), /Symlink|Unsafe|ELOOP/);
  const source = path.join(root, 'material'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'file.txt'), 'material');
  const bundle = await packMaterial({ sourceDir: source, sourceCommit: baseCommit });
  const first = path.join(root, 'first.json'), second = path.join(root, 'second.json');
  await fs.writeFile(first, bundle); await fs.writeFile(second, bundle);
  await fs.writeFile(path.join(repo, 'collision'), 'existing');
  const config = validateOfflineConfig({ materials: [
    { id: 'first', manifestPath: first, manifestSha256: hash(bundle), baseCommit, destination: 'new-place' },
    { id: 'second', manifestPath: second, manifestSha256: hash(bundle), baseCommit, destination: 'collision' },
  ] }, root);
  await assert.rejects(applyOfflineMaterials({ worktree: repo, baseCommit, selections: ['first', 'second'], config }), /collision/i);
  await assert.rejects(fs.access(path.join(repo, 'new-place')));
});

test('ignored imported files changed or deleted are captured apart from their baseline', async t => {
  const { root, repo } = await fixture(t);
  await fs.writeFile(path.join(repo, '.gitignore'), 'vendor/\n');
  git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'ignore vendor');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  const source = path.join(root, 'source'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'dep.js'), 'module.exports = 1;\n');
  const bundle = await packMaterial({ sourceDir: source, sourceCommit: baseCommit });
  const manifestPath = path.join(root, 'ignored.json'); await fs.writeFile(manifestPath, bundle);
  const config = validateOfflineConfig({ materials: [{ id: 'ignored', manifestPath, manifestSha256: hash(bundle), baseCommit, destination: 'vendor' }] }, root);
  const applied = await applyOfflineMaterials({ worktree: repo, baseCommit, selections: ['ignored'], config });
  const cleanJob = path.join(root, 'clean'); await fs.mkdir(cleanJob);
  assert.equal((await snapshotArtifacts({ jobDir: cleanJob, worktree: repo, baseCommit, materialBaseline: applied.materialBaseline, inputMaterialsDigest: applied.inputMaterialsDigest })).entries.length, 0);
  await fs.writeFile(path.join(repo, 'vendor', 'dep.js'), 'module.exports = 2;\n');
  const changedJob = path.join(root, 'changed'); await fs.mkdir(changedJob);
  const changed = await snapshotArtifacts({ jobDir: changedJob, worktree: repo, baseCommit, materialBaseline: applied.materialBaseline, inputMaterialsDigest: applied.inputMaterialsDigest });
  assert.equal(changed.entries.find(x => x.path === 'vendor/dep.js').type, 'file');
  const fresh = path.join(root, 'fresh'); git(root, 'clone', '-q', repo, fresh); git(fresh, 'checkout', '-q', baseCommit);
  await applyOfflineMaterials({ worktree: fresh, baseCommit, selections: ['ignored'], config });
  await restoreCheckpoint({ jobDir: changedJob, worktree: fresh });
  assert.equal(await fs.readFile(path.join(fresh, 'vendor', 'dep.js'), 'utf8'), 'module.exports = 2;\n');
  await fs.rm(path.join(repo, 'vendor', 'dep.js'));
  const deletedJob = path.join(root, 'deleted'); await fs.mkdir(deletedJob);
  const deleted = await snapshotArtifacts({ jobDir: deletedJob, worktree: repo, baseCommit, materialBaseline: applied.materialBaseline, inputMaterialsDigest: applied.inputMaterialsDigest });
  assert.equal(deleted.entries.find(x => x.path === 'vendor/dep.js').type, 'delete');
});

test('sanitizer expansion beyond public file bound is explicit and private checkpoint remains complete', async t => {
  const { repo, jobDir, baseCommit } = await fixture(t);
  await fs.writeFile(path.join(repo, 'changed.txt'), 'x'.repeat(600));
  const manifest = await snapshotArtifacts({ jobDir, worktree: repo, baseCommit, config: validateArtifactConfig({ maxFileBytes: 1024, maxTotalBytes: 2048, maxReadBytes: 512 }), sanitize: text => text.replaceAll('x', '[redacted]') });
  assert.equal(manifest.checkpointComplete, true);
  assert.equal(manifest.exportComplete, false);
  assert.equal(manifest.entries[0].omittedReason, 'public_output_limit');
  await assert.rejects(readArtifact(jobDir, { artifact_id: manifest.entries[0].id }), /unavailable/);
});

test('host export saver verifies public hashes and creates a new file only', async t => {
  const { root, repo, jobDir, baseCommit } = await fixture(t);
  await fs.writeFile(path.join(repo, 'changed.txt'), 'public export\n');
  await snapshotArtifacts({ jobDir, worktree: repo, baseCommit });
  const bundle = await exportArtifactBundle(jobDir);
  const destination = path.join(root, 'export.json');
  const script = new URL('../scripts/save-artifact-export.mjs', import.meta.url).pathname;
  execFileSync('node', [script, destination], { input: JSON.stringify(bundle), encoding: 'utf8' });
  assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).manifest.manifestSha256, bundle.manifest.manifestSha256);
  assert.throws(() => execFileSync('node', [script, destination], { input: JSON.stringify(bundle), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  const tampered = structuredClone(bundle); tampered.blobs[Object.keys(tampered.blobs)[0]] = Buffer.from('tampered').toString('base64');
  const failed = path.join(root, 'failed.json');
  assert.throws(() => execFileSync('node', [script, failed], { input: JSON.stringify(tampered), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  await assert.rejects(fs.access(failed));
});
