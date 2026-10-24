#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, buildChildEnv } from '../src/config.mjs';
import { Manager } from '../src/manager.mjs';
import { Workflow } from '../src/workflow.mjs';

process.umask(0o077);
const actions = new Set(['create', 'status', 'advance', 'cancel', 'release']);
const [action, argument] = process.argv.slice(2);
if (!actions.has(action) || !argument || process.argv.length !== 4 || !process.env.PI_MCP_CONFIG) {
  process.stderr.write('Usage: PI_MCP_CONFIG=<config> node scripts/workflow.mjs create <plan.json>|status|advance|cancel|release <goal-id>\n');
  process.exitCode = 2;
} else {
  try {
    const config = await loadConfig();
    const manager = await new Manager(config, buildChildEnv(config)).init();
    const workflow = new Workflow(manager);
    let result;
    if (action === 'create') {
      if (!path.isAbsolute(argument)) throw new Error('Plan path must be absolute');
      const handle = await fs.open(argument, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let plan;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 2 * 1024 * 1024) throw new Error('Invalid plan file');
        plan = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      result = await workflow.create(plan);
    } else result = await workflow[action](argument);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stderr.write('Workflow operation failed; inspect the private state and input.\n');
    process.exitCode = 1;
  }
}
