import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeTool } from '../src/policy.mjs';
import { RpcClient } from '../src/rpc.mjs';
import { sanitize } from '../src/sanitize.mjs';

test('policy rejects unknown tools, traversal, symlink and git administration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-policy-'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
  await fs.symlink(path.join(root, '.git'), path.join(root, 'git-alias'));
  const policy = { worktree: root, mode: 'implement', allowedCommands: ['npm test'] };
  assert.equal((await authorizeTool(policy, 'unknown', {})).allow, false);
  assert.equal((await authorizeTool(policy, 'read', { path: '../outside' })).allow, false);
  assert.equal((await authorizeTool(policy, 'read', { path: 'escape/x' })).allow, false);
  assert.equal((await authorizeTool(policy, 'read', { path: '.git/config' })).allow, false);
  assert.equal((await authorizeTool(policy, 'read', { path: 'git-alias/config' })).allow, false);
  assert.equal((await authorizeTool(policy, 'bash', { command: 'npm test' })).allow, false);
  assert.equal((await authorizeTool(policy, 'safe_shell', { command: 'npm test && id' })).allow, false);
  assert.equal((await authorizeTool(policy, 'safe_shell', { command: 'npm test' })).allow, true);
  assert.equal((await authorizeTool({ ...policy, allowedCommands: ['git commit -am x'] }, 'safe_shell', { command: 'git commit -am x' })).allow, false);
  assert.equal((await authorizeTool({ ...policy, mode: 'review' }, 'write', { path: 'x' })).allow, false);
});

test('public sanitization preserves usage counters while masking credentials', () => {
  const value = sanitize({ usage: { totalTokens: 7 }, apiKey: 'private-value', text: 'Bearer private-value' }, { TEST_API_KEY: 'private-value' });
  assert.equal(value.usage.totalTokens, 7);
  assert.equal(value.apiKey, '[redacted]');
  assert.equal(value.text.includes('private-value'), false);
  assert.equal(sanitize('pw%40rd and pw@rd', { HTTPS_PROXY: 'http://alice:pw%40rd@proxy.invalid:8080' }).includes('pw@rd'), false);
});

test('RPC waits for matching response and settled event, retaining U+2028', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough(); const output = new PassThrough();
  const client = new RpcClient(input, output);
  const sent = client.request('prompt', { message: 'a\u2028b' });
  const req = JSON.parse(output.read().toString());
  assert.equal(req.message, 'a\u2028b');
  input.write(JSON.stringify({ type: 'response', id: 'other', success: true }) + '\n');
  input.write(JSON.stringify({ type: 'response', id: req.id, command: 'prompt', success: true, data: { disposition: 'started' } }) + '\n');
  assert.equal((await sent).data.disposition, 'started');
  const settled = client.waitFor('agent_settled');
  input.write(JSON.stringify({ type: 'agent_end' }) + '\n');
  input.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
  assert.equal((await settled).type, 'agent_settled');
  client.close();
});
