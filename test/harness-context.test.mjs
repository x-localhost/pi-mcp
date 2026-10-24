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

test('real Pi aborts impossible mandatory context before any provider request', { timeout: 20_000 }, async () => {
  let requests = 0;
  const mock = http.createServer((_req, res) => { requests++; res.writeHead(500); res.end(); });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-context-'));
  let child; let rpc; let stderr = '';
  try {
    const agentDir = path.join(tmp, 'agent'); const worktree = path.join(tmp, 'worktree'); const sessionDir = path.join(tmp, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(worktree), fs.mkdir(sessionDir)]);
    await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY', models: [{ id: 'mock', name: 'Mock', contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const readyFile = path.join(tmp, 'ready.json');
    const stopFile = path.join(tmp, 'stop.json');
    const policyFile = path.join(tmp, 'policy.json');
    await fs.writeFile(policyFile, JSON.stringify({ nonce: 'test-nonce', readyFile, stopFile, worktree, mode: 'review', denyFile: path.join(tmp, 'deny.jsonl'), allowedCommands: [], context: { maxMessages: 8, maxBytes: 65_536 } }));
    child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline', '--tools', 'read,grep,find,ls', '--session-dir', sessionDir, '--session-id', 'context-test', '-e', extension], { cwd: worktree, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_MCP_POLICY: policyFile, MOCK_API_KEY: 'test-only-key', PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', DO_NOT_TRACK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    rpc = new RpcClient(child.stdout, child.stdin);
    let ready;
    for (let i = 0; i < 100; i++) { ready = await fs.readFile(readyFile, 'utf8').then(JSON.parse, () => null); if (ready || child.exitCode !== null) break; await sleep(100); }
    assert.ok(ready, stderr);
    await rpc.request('set_model', { provider: 'mock', modelId: 'mock' });
    const settled = rpc.waitFor('agent_settled', 10_000); settled.catch(() => {});
    const response = await rpc.request('prompt', { message: `Authoritative task: ${'x'.repeat(90_000)}` });
    assert.equal(response.data?.disposition, 'started');
    await settled;
    assert.equal(requests, 0, stderr);
    assert.equal(JSON.parse(await fs.readFile(stopFile, 'utf8')).reason, 'context_limit');
  } finally {
    rpc?.close(); child?.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child?.once('exit', resolve) ?? resolve()), sleep(1000)]);
    if (child?.exitCode === null) child.kill('SIGKILL');
    await new Promise(resolve => mock.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('real Pi drops a complete two-tool group and observation omits raw call data', { timeout: 20_000 }, async () => {
  const requests = [];
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = choice => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] })}\n\n`);
    if (requests.length === 1) {
      send({ delta: { role: 'assistant', content: 'X'.repeat(70_000), tool_calls: [
        { index: 0, id: 'RAW_SENTINEL_A', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
        { index: 1, id: 'RAW_SENTINEL_B', type: 'function', function: { name: 'read', arguments: '{"path":"b.txt"}' } },
      ] }, finish_reason: null });
      send({ delta: {}, finish_reason: 'tool_calls' });
    } else { send({ delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }); send({ delta: {}, finish_reason: 'stop' }); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-context-tools-'));
  let child; let rpc; let stderr = '';
  try {
    const agentDir = path.join(tmp, 'agent'); const worktree = path.join(tmp, 'worktree'); const sessionDir = path.join(tmp, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(worktree), fs.mkdir(sessionDir)]);
    await fs.writeFile(path.join(worktree, 'a.txt'), 'SECRET_RESULT_A');
    await fs.writeFile(path.join(worktree, 'b.txt'), 'SECRET_RESULT_B');
    await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY', models: [{ id: 'mock', name: 'Mock', contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const readyFile = path.join(tmp, 'ready.json'); const observationFile = path.join(tmp, 'events.jsonl');
    const policyFile = path.join(tmp, 'policy.json');
    await fs.writeFile(policyFile, JSON.stringify({ nonce: 'test-nonce', readyFile, observationFile, worktree, mode: 'review', denyFile: path.join(tmp, 'deny.jsonl'), allowedCommands: [], context: { maxMessages: 8, maxBytes: 65_536 } }));
    child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline', '--tools', 'read,grep,find,ls', '--session-dir', sessionDir, '--session-id', 'context-tools-test', '-e', extension], { cwd: worktree, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_MCP_POLICY: policyFile, MOCK_API_KEY: 'test-only-key', PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', DO_NOT_TRACK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    rpc = new RpcClient(child.stdout, child.stdin);
    let ready;
    for (let i = 0; i < 100; i++) { ready = await fs.readFile(readyFile, 'utf8').then(JSON.parse, () => null); if (ready || child.exitCode !== null) break; await sleep(100); }
    assert.ok(ready, stderr);
    await rpc.request('set_model', { provider: 'mock', modelId: 'mock' });
    const settled = rpc.waitFor('agent_settled', 10_000); settled.catch(() => {});
    const response = await rpc.request('prompt', { message: 'Read two files, then finish.' });
    assert.equal(response.data?.disposition, 'started');
    await settled;
    assert.equal(requests.length, 2, stderr);
    assert.equal(JSON.stringify(requests[1].messages).includes('RAW_SENTINEL_'), false);
    const observation = await fs.readFile(observationFile, 'utf8');
    assert.ok(observation.includes('context_reduction'));
    for (const marker of ['RAW_SENTINEL_', 'SECRET_RESULT_', 'Read two files', 'a.txt', 'b.txt']) assert.equal(observation.includes(marker), false);
    assert.ok(observation.includes('tool_start') && observation.includes('tool_end'));
  } finally {
    rpc?.close(); child?.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child?.once('exit', resolve) ?? resolve()), sleep(1000)]);
    if (child?.exitCode === null) child.kill('SIGKILL');
    await new Promise(resolve => mock.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
