#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) { process.stdout.write('1.4.0\n'); process.exit(0); }
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const policy = JSON.parse(await fs.readFile(process.env.PI_MCP_POLICY, 'utf8'));
const tools = policy.mode === 'review' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'safe_shell'];
await fs.writeFile(policy.readyFile, JSON.stringify({ nonce: policy.nonce, pid: process.pid, tools }));
const sessionFile = path.join(arg('--session-dir'), 'runtime-fixture.jsonl');
await fs.writeFile(sessionFile, '{"version":1}\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let model;
for await (const line of readline.createInterface({ input: process.stdin })) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.type === 'get_state') send({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionFile, model } });
  else if (request.type === 'get_session_stats') send({ type: 'response', id: request.id, command: request.type, success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } });
  else if (request.type === 'set_model') { model = { provider: request.provider, id: request.modelId, input: ['text'] }; send({ type: 'response', id: request.id, command: request.type, success: true, data: model }); }
  else if (request.type === 'abort') { send({ type: 'response', id: request.id, command: request.type, success: true }); process.exit(0); }
  else if (request.type === 'clear_queue' || request.type === 'set_thinking_level') send({ type: 'response', id: request.id, command: request.type, success: true });
  else if (request.type === 'prompt') {
    send({ type: 'response', id: request.id, command: request.type, success: true, data: { disposition: 'started' } });
    if (policy.mode !== 'review') await fs.writeFile(path.join(policy.worktree, 'code.txt'), 'retained code\n');
    if (request.message.includes('[OVERSIZE]')) await fs.appendFile(sessionFile, Buffer.alloc(17 * 1024 * 1024, 65));
    if (request.message.includes('[IDLE]')) continue;
    if (request.message.includes('[FAILURES]')) {
      await fs.writeFile(policy.activityFile, JSON.stringify({ version: 1, lastEventAt: new Date().toISOString(), lastProgressAt: new Date().toISOString(), consecutiveToolFailures: 3, lastKind: 'tool_end' }));
      continue;
    }
    send({ type: 'turn_start' });
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'completed' }], usage: { input: 1, output: 1 } } });
    send({ type: 'agent_settled' });
  }
}
