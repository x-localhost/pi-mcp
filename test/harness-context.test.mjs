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

test('real Pi reports logical calls and streaming progress without inventing inner SDK retry attempts', { timeout: 40_000 }, async t => {
  for (const failure of ['rate_limit', 'transport']) await t.test(failure, { timeout: 18_000 }, async () => {
    const requests = [];
    const mock = http.createServer((req, res) => {
      requests.push({ requestId: req.headers['x-pi-request-id'], attemptId: req.headers['x-pi-attempt-id'] });
      if (requests.length === 1 && failure === 'rate_limit') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '1' }); res.end(JSON.stringify({ error: { message: 'test retry', type: 'rate_limit_error' } })); return; }
      if (requests.length === 1 && failure === 'transport') { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let index = 0; const letters = ['H', 'e', 'l', 'l', 'o'];
      const timer = setInterval(() => {
        if (index < letters.length) res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: letters[index++] }, finish_reason: null }] })}\n\n`);
        else { clearInterval(timer); res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); res.end('data: [DONE]\n\n'); }
      }, 90);
    });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-retry-'));
    let child; let rpc; let stderr = '';
    try {
      const agentDir = path.join(tmp, 'agent'), worktree = path.join(tmp, 'worktree'), sessionDir = path.join(tmp, 'sessions');
      await Promise.all([fs.mkdir(agentDir), fs.mkdir(worktree), fs.mkdir(sessionDir)]);
      await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 1, maxRetryDelayMs: 1000 } } }));
      await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY', models: [{ id: 'mock', name: 'Mock', contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
      const readyFile = path.join(tmp, 'ready.json'), observationFile = path.join(tmp, 'events.jsonl'), activityFile = path.join(tmp, 'activity.json'), policyFile = path.join(tmp, 'policy.json');
      await fs.writeFile(policyFile, JSON.stringify({ nonce: 'test-nonce', readyFile, observationFile, activityFile, worktree, mode: 'review', denyFile: path.join(tmp, 'deny.jsonl'), allowedCommands: [], traceInternalGateway: true,
        jobId: '11111111-1111-4111-8111-111111111111', observation: { idleTimeoutMs: 400, maxEvents: 256, maxBytes: 65536 }, context: { maxMessages: 8, maxBytes: 65536 } }));
      child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline', '--tools', 'read,grep,find,ls', '--session-dir', sessionDir, '--session-id', `retry-${failure}`, '-e', extension],
        { cwd: worktree, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_MCP_POLICY: policyFile, MOCK_API_KEY: 'test-only-key', PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', DO_NOT_TRACK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); }); rpc = new RpcClient(child.stdout, child.stdin);
      let ready; for (let i = 0; i < 100; i++) { ready = await fs.readFile(readyFile, 'utf8').then(JSON.parse, () => null); if (ready || child.exitCode !== null) break; await sleep(100); }
      assert.ok(ready, stderr); await rpc.request('set_model', { provider: 'mock', modelId: 'mock' });
      const settled = rpc.waitFor('agent_settled', 12_000); settled.catch(() => {});
      assert.equal((await rpc.request('prompt', { message: 'Reply Hello.' })).data?.disposition, 'started'); await settled;
      assert.equal(requests.length, 2, stderr);
      assert.equal(requests[0].requestId, requests[1].requestId);
      assert.equal(requests[0].attemptId, requests[1].attemptId);
      const records = (await fs.readFile(observationFile, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(records.filter(item => item.kind === 'provider_retry').length, 0);
      assert.equal(records.filter(item => item.kind === 'provider_request').length, 1);
      assert.ok(records.filter(item => item.kind === 'assistant_progress').length >= 2);
      assert.equal(JSON.stringify(records).includes('Hello'), false);
      const second = rpc.waitFor('agent_settled', 10_000); second.catch(() => {});
      assert.equal((await rpc.request('prompt', { message: 'Reply again.' })).data?.disposition, 'started'); await second;
      assert.equal(requests.length, 3);
      assert.notEqual(requests[2].requestId, requests[1].requestId);
    } finally {
      rpc?.close(); child?.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child?.once('exit', resolve) ?? resolve()), sleep(1000)]);
      if (child?.exitCode === null) child.kill('SIGKILL');
      mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
