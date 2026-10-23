#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) { process.stdout.write('1.4.0\n'); process.exit(0); }
const option = name => process.argv[process.argv.indexOf(name) + 1];
const policy = JSON.parse(await fs.readFile(process.env.PI_MCP_POLICY, 'utf8'));
const tools = policy.mode === 'review' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'safe_shell'];
await fs.writeFile(policy.readyFile, JSON.stringify({ nonce: policy.nonce, pid: process.pid, tools }));
const sessionFile = process.argv.includes('--session') ? option('--session') : path.join(option('--session-dir'), 'fake-session.jsonl');
await fs.mkdir(path.dirname(sessionFile), { recursive: true });
await fs.appendFile(sessionFile, '{"type":"session"}\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.type === 'get_state') send({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionFile } });
  else if (['set_model', 'set_thinking_level', 'clear_queue', 'abort'].includes(request.type)) {
    send({ type: 'response', id: request.id, command: request.type, success: true });
    if (request.type === 'abort') process.exit(0);
  } else if (request.type === 'prompt') {
    const scenario = request.message.includes('[FAKE_HANG]') ? 'hang' : process.env.FAKE_PI_SCENARIO || 'success';
    send({ type: 'response', id: request.id, command: 'prompt', success: true, data: { disposition: scenario === 'handled' ? 'handled' : 'started' } });
    if (scenario === 'hang' || scenario === 'handled') continue;
    send({ type: 'turn_start' });
    send({ type: 'message_end', message: { role: 'assistant', stopReason: scenario === 'provider_error' ? 'error' : 'stop', errorMessage: scenario === 'provider_error' ? 'mock provider failure' : undefined, content: [{ type: 'text', text: 'Fake Pi completed' }], usage: { input: 1, output: 2 } } });
    send({ type: 'agent_end' });
    setTimeout(() => send({ type: 'agent_settled' }), 350);
  }
}
