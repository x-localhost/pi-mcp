import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '../src/rpc.mjs';
import { Manager } from '../src/manager.mjs';

const stallPi = fileURLToPath(new URL('./regression-stall-pi.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('malformed RPC line does not satisfy a pending response', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const rpc = new RpcClient(input, output);
  const pending = rpc.request('get_state', {}, 500);
  const request = JSON.parse(output.read().toString());
  let malformed = 0;
  rpc.on('malformed', () => malformed++);
  input.write('{broken json}\n');
  input.write(JSON.stringify({ type: 'response', id: request.id, command: 'get_state', success: true, data: { sessionFile: '/tmp/fake' } }) + '\n');
  assert.equal((await pending).data.sessionFile, '/tmp/fake');
  assert.equal(malformed, 1);
  rpc.close();
});

test('oversized RPC line rejects a pending request without waiting for its deadline', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const rpc = new RpcClient(input, output);
  const pending = rpc.request('get_state', {}, 10000);
  input.write('x'.repeat(1024 * 1024 + 1));
  await assert.rejects(pending, /RPC line exceeds 1 MiB/);
  rpc.close();
});

test('Pi that never acknowledges policy readiness times out and leaves no live process', { timeout: 25000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-regression-stall-'));
  const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Stall test.\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 1,
    defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, defaultMaxTurns: 2,
    piPath: process.execPath, piArgs: [stallPi], allowedCommands: [], provider: 'mock', model: 'mock' },
    { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }).init();
  const start = await manager.start({ repository, title: 'Stall', prompt: 'Stall.' });
  let status;
  for (let i = 0; i < 180; i++) {
    status = await manager.status(start.id);
    if (!['starting', 'running'].includes(status.status)) break;
    await pause(100);
  }
  assert.equal(status.status, 'timed_out', JSON.stringify(await manager.result(start.id)));
  const privateJob = await manager.read(start.id);
  assert.ok(privateJob.piPid);
  let processState = '';
  try { processState = execFileSync('ps', ['-o', 'stat=', '-p', String(privateJob.piPid)], { encoding: 'utf8' }).trim(); }
  catch {}
  assert.ok(!processState || processState.startsWith('Z'), `Pi process still alive: ${processState}`);
});
