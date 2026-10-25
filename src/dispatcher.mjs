#!/usr/bin/env node
import { loadConfig, buildChildEnv } from './config.mjs';
import { Manager } from './manager.mjs';
import { withOwnershipLock } from './ownership.mjs';
import path from 'node:path';

const configFile = process.argv[2];
if (!configFile || !path.isAbsolute(configFile)) process.exit(2);
const initial = await loadConfig(configFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Bounded, single-line, non-sensitive: this is operational noise for the
// detached dispatcher's own stderr, never job content.
const logLine = message => process.stderr.write(`${String(message).replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`);
// Distinguishes "the outer kernel dispatcher.lock was busy" (another
// dispatcher already owns it; this process should exit quietly) from any
// error surfacing once the loop is actually running, instead of matching
// the same "Ownership lock busy" text that manager.lock() (the unrelated
// per-submission submit.lock) can also throw.
let runEntered = false;
try {
  await withOwnershipLock(path.join(initial.stateDir, 'dispatcher.lock'), async () => {
    runEntered = true;
    while (true) {
      try {
        const config = await loadConfig(configFile);
        if (config.stateDir !== initial.stateDir) throw new Error('Dispatcher stateDir changed');
        const manager = await new Manager(config, buildChildEnv(config), { spawnWorker: true }).init();
        const outcome = await manager.dispatchOnce();
        // Keep the single kernel-locked dispatcher alive through idle periods.
        // An enqueue racing an idle check cannot be lost to a second process
        // that sees this lock busy and exits.
        await delay(outcome.pending ? config.queue.dispatchIntervalMs : Math.min(5000, config.queue.dispatchIntervalMs * 10));
      } catch (error) {
        // An administrator stateDir change is the one condition that must
        // still stop this dispatcher outright.
        if (error.message === 'Dispatcher stateDir changed') throw error;
        // Anything else per iteration - including the submit.lock being busy
        // with a concurrent submission after its own 10 s flock wait, or a
        // transient config reload failure - must not kill the only dispatcher
        // and stall the queue. Log, back off, and retry.
        logLine(`Dispatcher iteration failed, retrying: ${error.message}`);
        await delay(5000);
      }
    }
  }, { timeoutSeconds: 0 });
} catch (error) {
  if (!runEntered && /Ownership lock busy/.test(error.message)) {
    // Another dispatcher already holds the kernel lock; exit quietly.
  } else {
    process.stderr.write(`Dispatcher stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}
