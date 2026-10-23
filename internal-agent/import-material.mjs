#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateMaterialBundle } from '../src/offline-materials.mjs';
import { assertSandbox } from './sandbox.mjs';
import { loadAndValidateProfile } from './profile.mjs';

const [id, expectedSha256, sourceCommit] = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id || '') || !/^[0-9a-f]{64}$/.test(expectedSha256 || '') || !/^[0-9a-f]{40}$/.test(sourceCommit || '')) throw new Error('usage: import-material.mjs <id> <sha256> <source-commit>');
  await assertSandbox(); await loadAndValidateProfile();
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 128 * 1024 * 1024) throw new Error('material import size limit'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (sha(bytes) !== expectedSha256) throw new Error('material import digest mismatch');
  const result = validateMaterialBundle(JSON.parse(bytes));
  if (result.sourceCommit !== sourceCommit) throw new Error('material source commit mismatch');
  const dir = '/var/lib/pi-mcp/materials';
  if ((await fs.realpath('/var/lib/pi-mcp')) !== '/var/lib/pi-mcp') throw new Error('state directory must be canonical');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(dir)) !== dir || !(await fs.lstat(dir)).isDirectory()) throw new Error('material directory must be canonical');
  const target = path.join(dir, `${id}.json`);
  const handle = await fs.open(target, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await fs.rm(target, { force: true }); throw error; }
  await handle.close();
  console.log(JSON.stringify({ id, sha256: expectedSha256, fileCount: result.fileCount, totalBytes: result.totalBytes, manifestPath: target }));
} catch (error) {
  console.error(`material import refused: ${error.message}`);
  process.exitCode = 1;
}
