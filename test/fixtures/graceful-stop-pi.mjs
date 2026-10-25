#!/usr/bin/env node
// Minimal fake Pi used to exercise worker.mjs's stop()/abort handling. It
// behaves like test/fixtures/fake-pi.mjs for the startup handshake, starts a
// turn that never settles on its own, and then reacts to `abort` according to
// FAKE_PI_SCENARIO so tests can control exactly when (if ever) it stops:
//   - 'slow_exit' (default): answers abort, then after a short delay writes
//     graceful-abort.marker in the worktree and exits on its own, modelling a
//     Pi that needs a moment to finish writing its own aborted state.
//   - 'settle_then_exit': like 'slow_exit' but also emits agent_settled right
//     after answering abort, before the delayed exit.
//   - 'ignore_abort': never responds to abort and never exits on its own,
//     modelling a hung Pi that only a process-group signal can stop.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) { process.stdout.write('1.4.0\n'); process.exit(0); }
const option = name => process.argv[process.argv.indexOf(name) + 1];
const policy = JSON.parse(await fs.readFile(process.env.PI_MCP_POLICY, 'utf8'));
const tools = policy.mode === 'review' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'safe_shell'];
for (const server of policy.approvedMcp?.servers || []) for (const tool of server.tools) if (policy.mode !== 'review' || server.reviewTools.includes(tool.name)) tools.push(`mcp__${server.id}__${tool.name}`);
await fs.writeFile(policy.readyFile, JSON.stringify({ nonce: policy.nonce, pid: process.pid, tools }));
const sessionFile = process.argv.includes('--session') ? option('--session') : path.join(option('--session-dir'), 'fake-session.jsonl');
await fs.mkdir(path.dirname(sessionFile), { recursive: true });
await fs.appendFile(sessionFile, '{"type":"session"}\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const scenario = process.env.FAKE_PI_SCENARIO || 'slow_exit';
const markerFile = path.join(policy.worktree, 'graceful-abort.marker');
let selectedModel;
for await (const line of readline.createInterface({ input: process.stdin })) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.type === 'get_state') {
    send({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionFile, model: selectedModel } });
  } else if (request.type === 'get_session_stats') {
    send({ type: 'response', id: request.id, command: request.type, success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } });
  } else if (request.type === 'set_model') {
    selectedModel = { provider: request.provider, id: request.modelId };
    send({ type: 'response', id: request.id, command: request.type, success: true, data: selectedModel });
  } else if (['set_thinking_level', 'set_auto_retry', 'clear_queue', 'steer'].includes(request.type)) {
    send({ type: 'response', id: request.id, command: request.type, success: true, ...(request.type === 'steer' ? { data: { disposition: 'queued' } } : {}) });
  } else if (request.type === 'abort') {
    if (scenario === 'ignore_abort') continue;
    send({ type: 'response', id: request.id, command: 'abort', success: true });
    if (scenario === 'settle_then_exit') send({ type: 'agent_settled' });
    setTimeout(() => { fs.writeFile(markerFile, 'aborted-before-exit').then(() => process.exit(0)); }, 300);
  } else if (request.type === 'prompt') {
    send({ type: 'response', id: request.id, command: 'prompt', success: true, data: { disposition: 'started' } });
    send({ type: 'turn_start' });
    // Deliberately never settles on its own; the test drives cancellation
    // to exercise the worker's stop()/abort grace handling.
  }
}
