import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const payload = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
test('all seven MCP stdio tools survive reconnect and preserve job state', { timeout: 30000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-stdio-'));
  const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'AGENTS.md'), 'MCP test.'); git('add', '.'); git('commit', '-qm', 'base');
  const configFile = path.join(tmp, 'config.json');
  await fs.chmod(fake, 0o755);
  await fs.writeFile(configFile, JSON.stringify({ piPath: fake, stateDir: path.join(tmp, 'state'), allowedRoots: [tmp],
    provider: 'mock', model: 'mock', maxConcurrent: 2, defaultTimeoutSeconds: 10, maxTimeoutSeconds: 60, defaultMaxTurns: 2 }));
  const connect = async () => {
    const client = new Client({ name: 'pi-mcp-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath],
      env: { ...process.env, PI_MCP_CONFIG: configFile } });
    await client.connect(transport); return { client, transport };
  };
  let { client, transport } = await connect();
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['pi_cancel', 'pi_delegate', 'pi_followup', 'pi_health', 'pi_list', 'pi_result', 'pi_status']);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const health = payload(await call('pi_health'));
  assert.equal(health.version, '1.4.0');
  const started = payload(await call('pi_delegate', { repository, title: 'MCP', prompt: 'Do task', request_id: 'stable' }));
  assert.equal(payload(await call('pi_delegate', { repository, title: 'MCP', prompt: 'Do task', request_id: 'stable' })).id, started.id);
  await client.close(); await transport.close();
  ({ client, transport } = await connect());
  const again = (name, args = {}) => client.callTool({ name, arguments: args });
  let status;
  for (let i = 0; i < 100; i++) { status = payload(await again('pi_status', { job_id: started.id })); if (!['starting', 'running'].includes(status.status)) break; await delay(100); }
  assert.equal(status.status, 'completed');
  assert.match(payload(await again('pi_result', { job_id: started.id })).result, /Fake Pi completed/);
  assert.ok(payload(await again('pi_list', { limit: 10 })).some(job => job.id === started.id));
  const follow = payload(await again('pi_followup', { job_id: started.id, prompt: 'Continue' }));
  assert.equal(follow.worktree, started.worktree);
  for (let i = 0; i < 100; i++) { status = payload(await again('pi_status', { job_id: follow.id })); if (!['starting', 'running'].includes(status.status)) break; await delay(100); }
  assert.equal(status.status, 'completed');
  const hanging = payload(await again('pi_delegate', { repository, title: 'Hang', prompt: '[FAKE_HANG]' }));
  await delay(300);
  assert.equal(payload(await again('pi_cancel', { job_id: hanging.id })).cancellationRequested, true);
  for (let i = 0; i < 100; i++) { status = payload(await again('pi_status', { job_id: hanging.id })); if (!['starting', 'running'].includes(status.status)) break; await delay(100); }
  assert.equal(status.status, 'cancelled');
  await client.close(); await transport.close();
});
