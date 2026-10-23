import fs from 'node:fs/promises';
import path from 'node:path';
import { Manager } from '../src/manager.mjs';

const barrier = process.env.REGRESSION_BARRIER;
await fs.writeFile(path.join(barrier, `ready-${process.pid}`), 'ready');
while (!await fs.stat(path.join(barrier, 'go')).then(() => true, () => false)) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
try {
  const config = JSON.parse(process.env.REGRESSION_CONFIG);
  const input = JSON.parse(process.env.REGRESSION_INPUT);
  const manager = await new Manager(config, { PATH: process.env.PATH, HOME: process.env.HOME }, { spawnWorker: false }).init();
  const result = await manager.start(input, process.env.REGRESSION_PARENT || undefined);
  process.stdout.write(JSON.stringify({ ok: true, id: result.id, worktree: result.worktree }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
}
