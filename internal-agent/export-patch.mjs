#!/usr/bin/env node
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { assertSandbox } from './sandbox.mjs';
import { loadAndValidateProfile } from './profile.mjs';
import { validateConfig, buildChildEnv } from '../src/config.mjs';
import { Manager } from '../src/manager.mjs';
import { safeLstat, readRegular } from '../src/artifacts.mjs';

const [jobId] = process.argv.slice(2);
try {
  if (!/^task-[0-9a-f-]{36}$/.test(jobId || '')) throw new Error('usage: export-patch.mjs <job-id>');
  await assertSandbox(); await loadAndValidateProfile();
  const config = validateConfig(JSON.parse(await fs.readFile('/etc/pi-internal/config.json', 'utf8')), '/etc/pi-internal');
  // Same child env as the MCP server, so a cache built here is sanitized with
  // the same secret set and keyed identically.
  const manager = await new Manager(config, buildChildEnv(config), { spawnWorker: false }).init();
  // Metadata-only call builds (or reuses) the cache under the manager's own
  // lock; the cached file is then read directly rather than reassembled from
  // bounded pages, so the exact cached bytes reach stdout.
  const descriptor = await manager.patch(jobId, { include_text: false });
  const jobDir = manager.jobDir(jobId);
  const relative = path.relative(jobDir, descriptor.patchFile);
  await safeLstat(jobDir, relative);
  const { bytes } = await readRegular(descriptor.patchFile, 33 * 1024 * 1024);
  if (bytes.length !== descriptor.totalBytes || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('Patch cache integrity failure');
  await new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
  process.stderr.write(JSON.stringify({ sha256: descriptor.sha256, totalBytes: descriptor.totalBytes, applicable: descriptor.applicable }) + '\n');
} catch (error) {
  console.error(`patch export refused: ${error.message}`);
  process.exitCode = 1;
}
