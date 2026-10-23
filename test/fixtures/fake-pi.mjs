#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) { process.stdout.write('1.4.0\n'); process.exit(0); }
const option = name => process.argv[process.argv.indexOf(name) + 1];
const policy = JSON.parse(await fs.readFile(process.env.PI_MCP_POLICY, 'utf8'));
const tools = policy.mode === 'review' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'safe_shell'];
if (process.env.FAKE_PI_SCENARIO !== 'never_ready') await fs.writeFile(policy.readyFile, JSON.stringify({ nonce: policy.nonce, pid: process.pid, tools }));
const sessionFile = process.argv.includes('--session') ? option('--session') : path.join(option('--session-dir'), 'fake-session.jsonl');
await fs.mkdir(path.dirname(sessionFile), { recursive: true });
await fs.appendFile(sessionFile, '{"type":"session"}\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let selectedModel;
for await (const line of readline.createInterface({ input: process.stdin })) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.type === 'get_state') send({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionFile, model: selectedModel } });
  else if (['set_model', 'set_thinking_level', 'clear_queue', 'abort'].includes(request.type)) {
    if (request.type === 'set_model') selectedModel = process.env.FAKE_PI_SCENARIO === 'wrong_model'
      ? { provider: 'other', id: 'other' } : { provider: request.provider, id: request.modelId };
    send({ type: 'response', id: request.id, command: request.type, success: true, ...(request.type === 'set_model' ? { data: selectedModel } : {}) });
    if (request.type === 'abort') process.exit(0);
  } else if (request.type === 'prompt') {
    const scenario = request.message.includes('[FAKE_THROW_WRITER]') ? 'throw_writer'
      : request.message.includes('[FAKE_PROTOCOL_ERROR_WRITER]') ? 'protocol_error_writer'
      : request.message.includes('[FAKE_HANG]') ? 'hang' : process.env.FAKE_PI_SCENARIO || 'success';
    send({ type: 'response', id: request.id, command: 'prompt', success: true, data: { disposition: scenario === 'handled' ? 'handled' : 'started' } });
    if (scenario === 'protocol_error_writer' || scenario === 'throw_writer') {
      const marker = path.join(policy.worktree, 'writer.txt'); let count = 1;
      await fs.writeFile(marker, String(count));
      setInterval(() => fs.writeFile(marker, String(++count)).catch(() => {}), 50);
      if (scenario === 'throw_writer') send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: {} } });
      else send({ type: 'error', message: 'synthetic protocol error' });
      continue;
    }
    if (scenario === 'hang' || scenario === 'handled') continue;
    if (scenario === 'retry_success') {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'temporary failure', content: [] } });
      send({ type: 'auto_retry_end', success: true });
    }
    send({ type: 'turn_start' });
    const reply = ['secret_echo', 'secret_error'].includes(scenario) ? `credential ${process.env.CORP_SESSION} header prefix-${process.env.CORP_SESSION}` : 'Fake Pi completed';
    if (scenario === 'secret_echo') process.stderr.write(`credential ${reply}\n`);
    send({ type: 'message_end', message: { role: 'assistant', stopReason: ['provider_error', 'secret_error'].includes(scenario) ? 'error' : 'stop', errorMessage: scenario === 'provider_error' ? 'mock provider failure' : scenario === 'secret_error' ? reply : undefined, content: [{ type: 'text', text: reply }], usage: { input: 1, output: 2 } } });
    send({ type: 'agent_end' });
    setTimeout(() => send({ type: 'agent_settled' }), 350);
  }
}
