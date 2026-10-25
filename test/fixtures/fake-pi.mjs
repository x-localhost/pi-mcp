#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) { process.stdout.write('1.4.0\n'); process.exit(0); }
const option = name => process.argv[process.argv.indexOf(name) + 1];
const policy = JSON.parse(await fs.readFile(process.env.PI_MCP_POLICY, 'utf8'));
const tools = policy.mode === 'review' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'safe_shell'];
for (const server of policy.approvedMcp?.servers || []) for (const tool of server.tools) if (policy.mode !== 'review' || server.reviewTools.includes(tool.name)) tools.push(`mcp__${server.id}__${tool.name}`);
if (process.env.FAKE_PI_SCENARIO !== 'never_ready') await fs.writeFile(policy.readyFile, JSON.stringify({ nonce: policy.nonce, pid: process.pid, tools }));
const sessionFile = process.argv.includes('--session') ? option('--session') : path.join(option('--session-dir'), 'fake-session.jsonl');
await fs.mkdir(path.dirname(sessionFile), { recursive: true });
if (process.argv.includes('--fork')) await fs.copyFile(option('--fork'), sessionFile);
await fs.appendFile(sessionFile, '{"type":"session"}\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let selectedModel;
let statsInput = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.type === 'get_state') send({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionFile, model: selectedModel } });
  else if (request.type === 'get_session_stats') send({ type: 'response', id: request.id, command: request.type, success: true,
    data: { tokens: { input: statsInput, output: 0, cacheRead: 0, cacheWrite: 0, total: statsInput }, cost: 0 } });
  else if (['set_model', 'set_thinking_level', 'set_auto_retry', 'clear_queue', 'abort', 'steer'].includes(request.type)) {
    if (request.type === 'set_model') selectedModel = process.env.FAKE_PI_SCENARIO === 'wrong_model'
      ? { provider: 'other', id: 'other' } : { provider: request.provider, id: request.modelId, input: process.env.FAKE_PI_IMAGE_SUPPORT ? ['text', 'image'] : ['text'] };
    send({ type: 'response', id: request.id, command: request.type, success: true, ...(request.type === 'set_model' ? { data: selectedModel } : request.type === 'steer' ? { data: { disposition: 'queued' } } : {}) });
    if (request.type === 'abort') process.exit(0);
  } else if (request.type === 'prompt') {
    const scenario = request.message.includes('[FAKE_THROW_WRITER]') ? 'throw_writer'
      : request.message.includes('[FAKE_PROTOCOL_ERROR_WRITER]') ? 'protocol_error_writer'
      : request.message.includes('[FAKE_HANG]') ? 'hang' : request.message.includes('[FAKE_BUDGET]') ? 'budget'
      : request.message.includes('[FAKE_STATS_ONLY]') ? 'stats_only' : request.message.includes('[FAKE_NO_USAGE]') ? 'no_usage'
      : request.message.includes('[FAKE_NEGATIVE_USAGE]') ? 'negative_usage'
      : request.message.includes('[FAKE_TOTAL_ONLY]') ? 'total_only'
      : request.message.includes('[FAKE_TEXTLESS_TOOL]') ? 'textless_tool' : process.env.FAKE_PI_SCENARIO || 'success';
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
    if (request.message.includes('[FAKE_ARTIFACT_BASE64]')) await fs.writeFile(path.join(policy.worktree, 'encoded.txt'), 'Fake');
    if (scenario === 'retry_success') {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'temporary failure', content: [] } });
      send({ type: 'auto_retry_end', success: true });
    }
    send({ type: 'turn_start' });
    const reply = ['secret_echo', 'secret_error'].includes(scenario) ? `credential ${process.env.CORP_SESSION} header prefix-${process.env.CORP_SESSION}` : `Fake Pi completed${request.images?.length ? ` with ${request.images.length} images` : ''}`;
    if (scenario === 'secret_echo') process.stderr.write(`credential ${reply}\n`);
    statsInput = scenario === 'stats_only' ? 20 : scenario === 'budget' ? 10 : 1;
    send({ type: 'message_end', message: { role: 'assistant', stopReason: ['provider_error', 'secret_error'].includes(scenario) ? 'error' : 'stop', errorMessage: scenario === 'provider_error' ? 'mock provider failure' : scenario === 'secret_error' ? reply : undefined,
      content: scenario === 'textless_tool' ? [{ type: 'toolCall', name: 'read', arguments: { path: 'base.txt' } }] : [{ type: 'text', text: reply }],
      usage: ['no_usage', 'textless_tool'].includes(scenario) ? undefined : scenario === 'total_only' ? { totalTokens: 10 } : { input: scenario === 'negative_usage' ? -100 : scenario === 'budget' ? 10 : 1, output: scenario === 'budget' ? 10 : 2 } } });
    send({ type: 'agent_end' });
    setTimeout(() => send({ type: 'agent_settled' }), 350);
  }
}
