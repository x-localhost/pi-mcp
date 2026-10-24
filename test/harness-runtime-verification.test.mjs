import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runVerifier } from '../src/verification.mjs';
import { validateCompletionSections } from '../src/config.mjs';

test('declared root-owned script and asset hashes are checked before and after verifier execution', async () => {
  const root = '/opt/project-tools'; await fs.mkdir(root, { recursive: true });
  const script = path.join(root, 'harness-runtime-grader.mjs'); const asset = path.join(root, 'harness-runtime-asset.txt');
  await fs.writeFile(script, "import fs from 'node:fs'; fs.readFileSync('/opt/project-tools/harness-runtime-asset.txt'); process.stdout.write('ok');\n", { mode: 0o644 });
  await fs.writeFile(asset, 'pinned');
  const sha = file => fs.readFile(file).then(bytes => createHash('sha256').update(bytes).digest('hex'));
  const command = { id: 'grade', description: 'Protected fixture', argv: [process.execPath, script],
    protectedFiles: [{ path: script, sha256: await sha(script) }, { path: asset, sha256: await sha(asset) }], timeoutSeconds: 3, maxOutputBytes: 1000, readOnly: true };
  const normalized = validateCompletionSections({ verification: { commands: [command] } }, '/').verification.commands[0];
  const passed = await runVerifier(normalized, { cwd: '/tmp', env: process.env, sanitize: value => value });
  assert.equal(passed.status, 'passed'); assert.equal(passed.trust, 'declared_packaged_files'); assert.equal(passed.protectedFilesValid, true);
  await fs.writeFile(asset, 'changed');
  assert.equal((await runVerifier(normalized, { cwd: '/tmp', env: process.env, sanitize: value => value })).status, 'failed');
  await fs.rm(asset); await fs.symlink(script, asset);
  assert.equal((await runVerifier(normalized, { cwd: '/tmp', env: process.env, sanitize: value => value })).status, 'failed');
  await fs.rm(asset); await fs.rm(script);
});
