#!/usr/bin/env node
import path from 'node:path';
import { assertSandbox } from './sandbox.mjs';
import { loadAndValidateProfile } from './profile.mjs';
import { validateConfig } from '../src/config.mjs';
import { Manager, atomicJson, TERMINAL_STATUSES } from '../src/manager.mjs';
import { exportArtifactBundle } from '../src/artifacts.mjs';
import fs from 'node:fs/promises';

const [jobId] = process.argv.slice(2);
try {
  if (!/^task-[0-9a-f-]{36}$/.test(jobId || '')) throw new Error('usage: export-artifacts.mjs <job-id>');
  await assertSandbox(); await loadAndValidateProfile();
  const config = validateConfig(JSON.parse(await fs.readFile('/etc/pi-internal/config.json', 'utf8')), '/etc/pi-internal');
  const manager = await new Manager(config, {}, { spawnWorker: false }).init();
  await manager.lock(async () => {
    const job = await manager.read(jobId);
    if (!TERMINAL_STATUSES.has(job.status)) throw new Error('terminal job required');
    const bundle = await exportArtifactBundle(path.join(manager.jobsDir, jobId));
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(bundle) + '\n', error => error ? reject(error) : resolve()));
    job.exportedAt = new Date().toISOString();
    await atomicJson(path.join(manager.jobsDir, jobId, 'job.json'), job);
  });
} catch (error) {
  console.error(`artifact export refused: ${error.message}`);
  process.exitCode = 1;
}
