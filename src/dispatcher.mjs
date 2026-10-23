#!/usr/bin/env node
import { loadConfig, buildChildEnv } from './config.mjs';
import { Manager } from './manager.mjs';
import { withOwnershipLock } from './ownership.mjs';
import path from 'node:path';

const configFile = process.argv[2];
if (!configFile || !path.isAbsolute(configFile)) process.exit(2);
const initial = await loadConfig(configFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await withOwnershipLock(path.join(initial.stateDir, 'dispatcher.lock'), async () => {
    while (true) {
      const config = await loadConfig(configFile);
      if (config.stateDir !== initial.stateDir) throw new Error('Dispatcher stateDir changed');
      const manager = await new Manager(config, buildChildEnv(config), { spawnWorker: true }).init();
      const outcome = await manager.dispatchOnce();
      // Keep the single kernel-locked dispatcher alive through idle periods.
      // An enqueue racing an idle check cannot be lost to a second process
      // that sees this lock busy and exits.
      await delay(outcome.pending ? config.queue.dispatchIntervalMs : Math.min(5000, config.queue.dispatchIntervalMs * 10));
    }
  }, { timeoutSeconds: 0 });
} catch (error) {
  if (!/Ownership lock busy/.test(error.message)) {
    process.stderr.write(`Dispatcher stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}
