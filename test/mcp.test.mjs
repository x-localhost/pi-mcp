import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const payload = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
test('bounded MCP stdio controls and artifacts survive reconnect and preserve job state', { timeout: 60000 }, async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-stdio-'));
  const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'AGENTS.md'), 'MCP test.'); git('add', '.'); git('commit', '-qm', 'base');
  const configFile = path.join(tmp, 'config.json');
  await fs.chmod(fake, 0o755);
  await fs.writeFile(configFile, JSON.stringify({ piPath: fake, stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], envAllowlist: ['CORP_SESSION'],
    provider: 'mock', model: 'mock', maxConcurrent: 2, defaultTimeoutSeconds: 10, maxTimeoutSeconds: 60, defaultMaxTurns: 2,
    verification: { commands: [{ id: 'unit', argv: ['/usr/bin/true'], timeoutSeconds: 3, maxOutputBytes: 1000 }] },
    approvedMcp: { servers: [{ id: 'docs', transport: 'stdio', command: '/usr/local/bin/node', args: ['/app/approved-mcp/mock.mjs'], cwd: '/app/approved-mcp', env: { MCP_KEY: 'a' },
      tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }], reviewTools: ['read'] }] } }));
  const connect = async () => {
    const client = new Client({ name: 'pi-mcp-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath],
      env: { ...process.env, CORP_SESSION: 'RmFrZQ', PI_MCP_CONFIG: configFile } });
    await client.connect(transport); return { client, transport };
  };
  let { client, transport } = await connect();
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['pi_artifacts', 'pi_attest_review', 'pi_cancel', 'pi_capabilities', 'pi_cleanup', 'pi_delegate', 'pi_events', 'pi_followup', 'pi_fork', 'pi_health', 'pi_list', 'pi_patch', 'pi_read_artifact', 'pi_recover', 'pi_result', 'pi_review', 'pi_rollover', 'pi_status', 'pi_steer', 'pi_wait']);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const health = payload(await call('pi_health'));
  assert.equal(health.version, '1.4.0');
  const capabilities = payload(await call('pi_capabilities'));
  assert.equal(capabilities.version, 1);
  assert.equal(capabilities.models[0].model, 'mock');
  const started = payload(await call('pi_delegate', { repository, title: 'MCP', prompt: 'Do task [FAKE_ARTIFACT_BASE64]', verification_ids: ['unit'], request_id: 'stable' }));
  assert.equal(payload(await call('pi_delegate', { repository, title: 'MCP', prompt: 'Do task [FAKE_ARTIFACT_BASE64]', verification_ids: ['unit'], request_id: 'stable' })).id, started.id);
  await client.close(); await transport.close();
  ({ client, transport } = await connect());
  const again = (name, args = {}) => client.callTool({ name, arguments: args });
  let status;
  for (let i = 0; i < 100; i++) { status = payload(await again('pi_status', { job_id: started.id })); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) break; await delay(100); }
  assert.equal(status.status, 'completed');
  assert.equal(status.id, started.id);
  assert.equal(status.verification.status, 'passed');
  assert.match(payload(await again('pi_result', { job_id: started.id })).result, /F\[redacted\]ke Pi completed/);
  const artifacts = payload(await again('pi_artifacts', { job_id: started.id }));
  assert.equal(artifacts.checkpointComplete, true);
  const resultArtifact = artifacts.entries.find(entry => entry.path === 'reports/result');
  assert.ok(resultArtifact);
  const blob = payload(await again('pi_read_artifact', { job_id: started.id, artifact_id: resultArtifact.id }));
  assert.match(Buffer.from(blob.data_base64, 'base64').toString(), /F\[redacted\]ke Pi completed/);
  const verificationEntry = artifacts.entries.find(entry => entry.path === 'reports/verification');
  const verificationBlob = payload(await again('pi_read_artifact', { job_id: started.id, artifact_id: verificationEntry.id }));
  const verificationReport = JSON.parse(Buffer.from(verificationBlob.data_base64, 'base64').toString());
  assert.equal(verificationReport.status, status.verification.status);
  assert.equal(verificationReport.verifiedSnapshotDigest, artifacts.inputSnapshotDigest);
  const encodedArtifact = artifacts.entries.find(entry => entry.path === 'encoded.txt');
  const encoded = payload(await again('pi_read_artifact', { job_id: started.id, artifact_id: encodedArtifact.id }));
  assert.equal(encoded.data_base64, Buffer.from('F[redacted]ke').toString('base64'));
  assert.equal(createHash('sha256').update(Buffer.from(encoded.data_base64, 'base64')).digest('hex'), encoded.totalSha256);
  assert.ok(payload(await again('pi_events', { job_id: started.id })).events.length > 0);
  assert.ok(payload(await again('pi_list', { limit: 10 })).some(job => job.id === started.id));
  const follow = payload(await again('pi_followup', { job_id: started.id, prompt: 'Continue' }));
  assert.equal(follow.worktree, started.worktree);
  for (let i = 0; i < 100; i++) { status = payload(await again('pi_status', { job_id: follow.id })); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) break; await delay(100); }
  assert.equal(status.status, 'completed');
  const hanging = payload(await again('pi_delegate', { repository, title: 'Hang', prompt: '[FAKE_HANG]' }));
  for (let i = 0; i < 100; i++) { status = payload(await again('pi_status', { job_id: hanging.id })); if (status.status === 'running') break; await delay(100); }
  assert.equal(status.status, 'running');
  const steering = payload(await again('pi_steer', { job_id: hanging.id, message: 'private steer' }));
  assert.equal(steering.status, 'queued_by_pi');
  const steerEvents = payload(await again('pi_events', { job_id: hanging.id })).events.filter(event => event.type === 'steer');
  assert.ok(steerEvents.some(event => event.controlId === steering.control_id && event.status === 'queued_by_pi'));
  const cancellation = payload(await again('pi_cancel', { job_id: hanging.id }));
  assert.ok(cancellation.cancellationRequested || cancellation.status === 'cancelled');
  for (let i = 0; i < 100; i++) { status = payload(await again('pi_status', { job_id: hanging.id })); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) break; await delay(100); }
  assert.equal(status.status, 'cancelled');
  await client.close(); await transport.close();
});

test('MCP artifact pages preserve a secret that appears only in base64 transport', { timeout: 20000 }, async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-base64-'));
  const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const configFile = path.join(tmp, 'config.json'); await fs.chmod(fake, 0o755);
  await fs.writeFile(configFile, JSON.stringify({ piPath: fake, stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], envAllowlist: ['CORP_SESSION'],
    provider: 'mock', model: 'mock', maxConcurrent: 1, defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, defaultMaxTurns: 2 }));
  const client = new Client({ name: 'pi-mcp-base64', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, CORP_SESSION: 'RmFrZQ', PI_MCP_CONFIG: configFile } });
  await client.connect(transport);
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const started = payload(await call('pi_delegate', { repository, title: 'Encoded', prompt: '[FAKE_ARTIFACT_BASE64]' }));
  let status;
  for (let i = 0; i < 100; i++) { status = payload(await call('pi_status', { job_id: started.id })); if (!['queued', 'starting', 'running', 'finalizing'].includes(status.status)) break; await delay(100); }
  assert.equal(status.status, 'completed');
  const manifest = payload(await call('pi_artifacts', { job_id: started.id }));
  const entry = manifest.entries.find(item => item.path === 'encoded.txt');
  const page = payload(await call('pi_read_artifact', { job_id: started.id, artifact_id: entry.id }));
  assert.equal(page.data_base64, 'RmFrZQ==');
  assert.equal(createHash('sha256').update(Buffer.from(page.data_base64, 'base64')).digest('hex'), page.totalSha256);
});
