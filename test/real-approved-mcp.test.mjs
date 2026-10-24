import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '../src/rpc.mjs';

const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const extension = fileURLToPath(new URL('../src/policy-extension.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inputSchema = { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['path'], additionalProperties: false };

test('real Pi 1.4.0 registers approved MCP at session_start and executes a pinned tool', { timeout: 30000 }, async () => {
  const seen = [];
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); seen.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = choice => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] })}\n\n`);
    if (seen.length === 1) {
      send({ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-approved', type: 'function', function: { name: 'mcp__docs__read', arguments: '{"path":"guide.md"}' } }] }, finish_reason: null });
      send({ delta: {}, finish_reason: 'tool_calls' });
    } else {
      send({ delta: { role: 'assistant', content: 'Approved MCP completed.' }, finish_reason: null });
      send({ delta: {}, finish_reason: 'stop' });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'real-approved-mcp-'));
  let child; let rpc; let stderr = ''; const events = [];
  try {
    const agentDir = path.join(tmp, 'agent'); const worktree = path.join(tmp, 'worktree'); const sessionDir = path.join(tmp, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(worktree), fs.mkdir(sessionDir)]);
    await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY', models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const readyFile = path.join(tmp, 'ready.json');
    const policyFile = path.join(tmp, 'policy.json');
    await fs.writeFile(policyFile, JSON.stringify({ nonce: 'test-nonce', readyFile, denyFile: path.join(tmp, 'denials.jsonl'), worktree, mode: 'review', allowedCommands: [], approvedMcp: { servers: [{ id: 'docs', transport: 'stdio', command: '/usr/local/bin/node', args: ['/app/approved-mcp/mock.mjs'], cwd: '/app/approved-mcp', env: {}, tools: [{ name: 'read', description: 'Read a document', inputSchema }], reviewTools: ['read'] }] } }));
    child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline', '--tools', 'read,grep,find,ls,mcp__docs__read', '--session-dir', sessionDir, '--session-id', 'approved-mcp-test', '-e', extension], { cwd: worktree, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_MCP_POLICY: policyFile, MOCK_API_KEY: 'test-only-key', PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', DO_NOT_TRACK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    rpc = new RpcClient(child.stdout, child.stdin);
    rpc.on('event', event => { if (events.length < 20) events.push(event); });
    let ready;
    for (let i = 0; i < 100; i++) {
      ready = await fs.readFile(readyFile, 'utf8').then(JSON.parse).catch(() => null);
      if (ready) break;
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    assert.ok(ready, `Pi readiness missing: ${stderr}; events=${JSON.stringify(events)}`);
    assert.ok(ready.tools.includes('mcp__docs__read'));
    await rpc.request('set_model', { provider: 'mock', modelId: 'mock' });
    const settled = rpc.waitFor('agent_settled', 15000); settled.catch(() => {});
    const prompt = await rpc.request('prompt', { message: 'Read guide.md with the approved MCP tool, then finish.' });
    assert.equal(prompt.data?.disposition, 'started');
    await settled;
    assert.equal(seen.length, 2);
    assert.ok(seen[0].tools.some(entry => entry.function?.name === 'mcp__docs__read'));
    assert.ok(JSON.stringify(seen[1].messages).includes('DOC:guide.md'));
  } finally {
    rpc?.close(); child?.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child?.once('exit', resolve) ?? resolve()), sleep(1000)]);
    if (child?.exitCode === null) child.kill('SIGKILL');
    await new Promise(resolve => mock.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
