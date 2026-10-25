#!/usr/bin/env node
// Fake Pi RPC process for test/provider-recovery.test.mjs. Scenario is
// picked once from a marker in the *first* prompt message (continuation
// prompts sent by the worker's recovery loop never repeat that marker), and
// reused for every later prompt in the same run so the recovery sequence
// stays deterministic across attempts.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) { process.stdout.write('1.4.0\n'); process.exit(0); }
const option = name => process.argv[process.argv.indexOf(name) + 1];
const policy = JSON.parse(await fs.readFile(process.env.PI_MCP_POLICY, 'utf8'));
const tools = policy.mode === 'review' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'safe_shell'];
await fs.writeFile(policy.readyFile, JSON.stringify({ nonce: policy.nonce, pid: process.pid, tools }));
const sessionFile = path.join(option('--session-dir'), 'provider-recovery-fixture.jsonl');
await fs.mkdir(path.dirname(sessionFile), { recursive: true });
await fs.writeFile(sessionFile, '{"type":"session"}\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let selectedModel;
let scenario = null;
let promptCount = 0;

for await (const line of readline.createInterface({ input: process.stdin })) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.type === 'get_state') send({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionFile, model: selectedModel } });
  else if (request.type === 'get_session_stats') send({ type: 'response', id: request.id, command: request.type, success: true,
    data: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } });
  else if (request.type === 'set_model') {
    selectedModel = { provider: request.provider, id: request.modelId, input: ['text'] };
    send({ type: 'response', id: request.id, command: request.type, success: true, data: selectedModel });
  }
  else if (request.type === 'set_auto_retry') {
    if (request.enabled === true) await fs.writeFile(path.join(path.dirname(policy.readyFile), 'auto-retry-received.json'), JSON.stringify({ enabled: true }));
    send({ type: 'response', id: request.id, command: request.type, success: true });
  }
  else if (request.type === 'steer') send({ type: 'response', id: request.id, command: request.type, success: true, data: { disposition: 'queued' } });
  else if (['set_thinking_level', 'clear_queue'].includes(request.type)) send({ type: 'response', id: request.id, command: request.type, success: true });
  else if (request.type === 'abort') { send({ type: 'response', id: request.id, command: request.type, success: true }); process.exit(0); }
  else if (request.type === 'prompt') {
    promptCount++;
    if (!scenario) {
      scenario = request.message.includes('[FAKE_RECOVER_ONCE_SLOW_SETTLE]') ? 'recover_once_slow'
        : request.message.includes('[FAKE_EXIT_DURING_BACKOFF]') ? 'exit_during_backoff'
        : request.message.includes('[FAKE_RECOVER_ONCE]') ? 'recover_once'
        : request.message.includes('[FAKE_EARLY_TEXT_THEN_EMPTY]') ? 'early_text_then_empty'
        : request.message.includes('[FAKE_ALWAYS_EMPTY]') ? 'always_empty'
        : request.message.includes('[FAKE_AUTH_ERROR]') ? 'auth_error'
        : 'success';
    }
    send({ type: 'response', id: request.id, command: 'prompt', success: true, data: { disposition: 'started' } });
    send({ type: 'turn_start' });
    if (scenario === 'recover_once' || scenario === 'recover_once_slow') {
      if (promptCount === 1) send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } });
      else send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Recovered answer' }], usage: { input: 1, output: 2 } } });
    } else if (scenario === 'exit_during_backoff') {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } });
    } else if (scenario === 'early_text_then_empty') {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Earlier progress' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'base.txt' } }], usage: { input: 1, output: 2 } } });
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } });
    } else if (scenario === 'always_empty') {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } });
    } else if (scenario === 'auth_error') {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '401 Unauthorized: invalid API key', content: [] } });
    } else {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Fake completed' }], usage: { input: 1, output: 2 } } });
    }
    send({ type: 'agent_end' });
    if (scenario === 'exit_during_backoff' && promptCount === 1) {
      // Settle normally (empty, recoverable), then simulate Pi crashing
      // partway through the worker's recovery backoff.
      setTimeout(() => { send({ type: 'agent_settled' }); setTimeout(() => process.exit(1), 250); }, 50);
    } else if (scenario === 'recover_once_slow' && promptCount === 2) {
      // Settle the continuation slowly enough that at least one 500ms
      // watchdog tick lands while piActive is true after it was sent, so a
      // stale idle baseline (one that ignores the backoff just taken) would
      // reliably be caught stopping the job as idle_timeout.
      setTimeout(() => send({ type: 'agent_settled' }), 1200);
    } else {
      setTimeout(() => send({ type: 'agent_settled' }), 50);
    }
  }
}
