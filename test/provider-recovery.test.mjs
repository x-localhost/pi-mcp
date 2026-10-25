import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classifyFinalMessage, recoveryDelayMs } from '../src/provider-recovery.mjs';
import { validateConfig } from '../src/config.mjs';
import { capabilities } from '../src/capabilities.mjs';
import { Manager } from '../src/manager.mjs';

const fake = fileURLToPath(new URL('./fixtures/provider-recovery-fake-pi.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function minimalRaw(dir) {
  return { piPath: path.join(dir, 'pi'), stateDir: path.join(dir, 'state'), allowedRoots: [path.join(dir, 'roots', 'a')] };
}

// =======================================================================
// classifyFinalMessage
// =======================================================================

describe('classifyFinalMessage', () => {
  test('healthy: stop with visible text', () => {
    assert.deepEqual(classifyFinalMessage({ stopReason: 'stop', content: [{ type: 'text', text: 'All done.' }] }), { healthy: true });
  });

  test('healthy: end_turn with visible text', () => {
    assert.deepEqual(classifyFinalMessage({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Finished.' }] }), { healthy: true });
  });

  test('not healthy: text made only of control characters and U+FFFD counts as empty', () => {
    const result = classifyFinalMessage({ stopReason: 'stop', content: [{ type: 'text', text: '\u0000\u0000�  ' }] });
    assert.equal(result.healthy, false);
    assert.equal(result.reason, 'empty_response');
  });

  for (const stopReason of ['stop', 'end_turn', 'toolUse']) {
    test(`empty_response: ${stopReason} with no visible text and no tool calls`, () => {
      assert.deepEqual(classifyFinalMessage({ stopReason, content: [] }), { healthy: false, recoverable: true, reason: 'empty_response' });
    });
  }

  test('not empty_response: toolUse with an actual tool call is not classified as empty', () => {
    const result = classifyFinalMessage({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }] });
    assert.equal(result.healthy, false);
    assert.equal(result.reason, 'provider_error');
  });

  test('truncated_empty: length with no visible text and no tool calls', () => {
    assert.deepEqual(classifyFinalMessage({ stopReason: 'length', content: [] }), { healthy: false, recoverable: true, reason: 'truncated_empty' });
  });

  test('length with text is not healthy and not recoverable (keeps current failure semantics)', () => {
    const result = classifyFinalMessage({ stopReason: 'length', content: [{ type: 'text', text: 'cut off mid-sent' }] });
    assert.deepEqual(result, { healthy: false, recoverable: false, reason: 'provider_error' });
  });

  for (const errorMessage of ['Unexpected token } in JSON at position 4', 'Unexpected end of JSON input', 'Could not parse message into JSON', 'invalid response from provider', 'Stream ended without finish_reason', 'empty response body']) {
    test(`malformed_response: error "${errorMessage}"`, () => {
      assert.deepEqual(classifyFinalMessage({ stopReason: 'error', errorMessage, content: [] }), { healthy: false, recoverable: true, reason: 'malformed_response' });
    });
  }

  for (const errorMessage of ['Request failed with status code 429', 'upstream returned 503', 'the model is overloaded, please retry', 'request timed out after 30s', 'terminated', 'socket hang up', 'connection reset by peer']) {
    test(`provider_unavailable: error "${errorMessage}"`, () => {
      assert.deepEqual(classifyFinalMessage({ stopReason: 'error', errorMessage, content: [] }), { healthy: false, recoverable: true, reason: 'provider_unavailable' });
    });
  }

  for (const errorMessage of ['401 Unauthorized: invalid API key', '403 Forbidden', 'insufficient_quota: billing hard limit reached', 'content_filter: response blocked by safety system', 'maximum context length exceeded']) {
    test(`provider_error (not recoverable): error "${errorMessage}"`, () => {
      assert.deepEqual(classifyFinalMessage({ stopReason: 'error', errorMessage, content: [] }), { healthy: false, recoverable: false, reason: 'provider_error' });
    });
  }

  test('provider_error (not recoverable): aborted', () => {
    assert.deepEqual(classifyFinalMessage({ stopReason: 'aborted', content: [] }), { healthy: false, recoverable: false, reason: 'provider_error' });
  });

  test('provider_error (not recoverable): unmapped/missing stop reason', () => {
    assert.deepEqual(classifyFinalMessage({ stopReason: 'other', content: [] }), { healthy: false, recoverable: false, reason: 'provider_error' });
    assert.deepEqual(classifyFinalMessage({}), { healthy: false, recoverable: false, reason: 'provider_error' });
  });
});

// =======================================================================
// recoveryDelayMs
// =======================================================================

describe('recoveryDelayMs', () => {
  const policy = { baseDelayMs: 5000, maxDelayMs: 60000 };
  test('exponential growth from baseDelayMs', () => {
    assert.equal(recoveryDelayMs(policy, 1), 5000);
    assert.equal(recoveryDelayMs(policy, 2), 10000);
    assert.equal(recoveryDelayMs(policy, 3), 20000);
    assert.equal(recoveryDelayMs(policy, 4), 40000);
  });
  test('capped at maxDelayMs', () => {
    assert.equal(recoveryDelayMs(policy, 5), 60000);
    assert.equal(recoveryDelayMs(policy, 10), 60000);
  });
  test('never exceeds maxDelayMs even for huge attempt numbers', () => {
    assert.equal(recoveryDelayMs(policy, 1000), 60000);
  });
});

// =======================================================================
// config validation
// =======================================================================

describe('providerRecovery config validation', () => {
  test('defaults when omitted', async () => {
    const dir = await makeTempDir('pi-mcp-provrec-');
    const config = validateConfig(minimalRaw(dir), dir);
    assert.deepEqual(config.providerRecovery, { maxAttempts: 2, baseDelayMs: 5000, maxDelayMs: 60000 });
  });

  test('accepts explicit values within bounds, including maxAttempts: 0 (disables recovery)', async () => {
    const dir = await makeTempDir('pi-mcp-provrec-');
    const config = validateConfig({ ...minimalRaw(dir), providerRecovery: { maxAttempts: 0, baseDelayMs: 1000, maxDelayMs: 1000 } }, dir);
    assert.deepEqual(config.providerRecovery, { maxAttempts: 0, baseDelayMs: 1000, maxDelayMs: 1000 });
  });

  test('rejects unknown keys', async () => {
    const dir = await makeTempDir('pi-mcp-provrec-');
    assert.throws(() => validateConfig({ ...minimalRaw(dir), providerRecovery: { maxAttempts: 1, bogus: true } }, dir), /providerRecovery/);
  });

  for (const [field, value, bound] of [['maxAttempts', 6, '0 and 5'], ['maxAttempts', -1, '0 and 5'], ['baseDelayMs', -1, '0 and 120000'], ['baseDelayMs', 120001, '0 and 120000'], ['maxDelayMs', -1, '0 and 600000'], ['maxDelayMs', 600001, '0 and 600000']]) {
    test(`rejects ${field}=${value} (out of ${bound})`, async () => {
      const dir = await makeTempDir('pi-mcp-provrec-');
      assert.throws(() => validateConfig({ ...minimalRaw(dir), providerRecovery: { [field]: value } }, dir), /providerRecovery/);
    });
  }

  test('rejects maxDelayMs below baseDelayMs', async () => {
    const dir = await makeTempDir('pi-mcp-provrec-');
    assert.throws(() => validateConfig({ ...minimalRaw(dir), providerRecovery: { baseDelayMs: 10000, maxDelayMs: 5000 } }, dir), /providerRecovery/);
  });
});

// =======================================================================
// pi_capabilities exposure
// =======================================================================

test('capabilities exposes providerRecovery version and configured values', () => {
  const result = capabilities({ providerRecovery: { maxAttempts: 2, baseDelayMs: 5000, maxDelayMs: 60000 } });
  assert.deepEqual(result.providerRecovery, { version: 1, maxAttempts: 2, baseDelayMs: 5000, maxDelayMs: 60000 });
});

// =======================================================================
// worker-level recovery behavior (fake Pi)
// =======================================================================

async function setupWorker(t, providerRecovery) {
  const tmp = await makeTempDir('pi-provrec-worker-');
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const repository = path.join(tmp, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'base.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  await fs.chmod(fake, 0o755);
  const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 2, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 30, defaultMaxTurns: 5,
    piPath: fake, allowedCommands: [], providerRecovery }, { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }).init();
  const input = { repository, title: 'Provider recovery', prompt: 'Use fake Pi', provider: 'mock', model: 'mock' };
  return { manager, input };
}
async function finished(manager, id, limit = 150) {
  for (let i = 0; i < limit; i++) { const status = await manager.status(id); if (!['queued', 'starting', 'running', 'finalizing', 'verifying'].includes(status.status)) return status; await delay(100); }
  throw new Error('Job did not finish');
}

test('empty final message recovers to a healthy answer: completed, attempts 1', { timeout: 20000 }, async t => {
  const { manager, input } = await setupWorker(t, { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 200 });
  const started = await manager.start({ ...input, prompt: '[FAKE_RECOVER_ONCE] do the task' });
  const status = await finished(manager, started.id);
  assert.equal(status.status, 'completed', JSON.stringify(status));
  assert.match((await manager.result(started.id)).result, /Recovered answer/);
  assert.deepEqual(status.providerRecovery.maxAttempts, 2);
  assert.equal(status.providerRecovery.attempts, 1);
  assert.equal(status.providerRecovery.history.length, 1);
  assert.equal(status.providerRecovery.history[0].reason, 'empty_response');
});

test('earlier text then an empty final message with maxAttempts 0 fails the job (closes the old hole)', { timeout: 20000 }, async t => {
  const { manager, input } = await setupWorker(t, { maxAttempts: 0, baseDelayMs: 50, maxDelayMs: 200 });
  const started = await manager.start({ ...input, prompt: '[FAKE_EARLY_TEXT_THEN_EMPTY] do the task' });
  const status = await finished(manager, started.id);
  assert.equal(status.status, 'failed', JSON.stringify(status));
  assert.match(status.error, /Provider returned empty_response \(recovery exhausted after 0 attempts\)/);
});

test('recovery exhausted after configured attempts fails with the exhaustion error', { timeout: 20000 }, async t => {
  const { manager, input } = await setupWorker(t, { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 200 });
  const started = await manager.start({ ...input, prompt: '[FAKE_ALWAYS_EMPTY] do the task' });
  const status = await finished(manager, started.id);
  assert.equal(status.status, 'failed', JSON.stringify(status));
  assert.match(status.error, /Provider returned empty_response \(recovery exhausted after 1 attempts\)/);
  assert.equal(status.providerRecovery.attempts, 1);
  assert.equal(status.providerRecovery.history.length, 1);
});

test('non-recoverable provider error (401) fails immediately without recovery', { timeout: 20000 }, async t => {
  const { manager, input } = await setupWorker(t, { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 200 });
  const started = await manager.start({ ...input, prompt: '[FAKE_AUTH_ERROR] do the task' });
  const status = await finished(manager, started.id);
  assert.equal(status.status, 'failed', JSON.stringify(status));
  assert.match(status.error, /401 Unauthorized/);
  assert.equal(status.providerRecovery.attempts, 0);
  assert.deepEqual(status.providerRecovery.history, []);
});

test('cancel during the recovery backoff stops promptly', { timeout: 20000 }, async t => {
  const { manager, input } = await setupWorker(t, { maxAttempts: 2, baseDelayMs: 15000, maxDelayMs: 15000 });
  const started = await manager.start({ ...input, prompt: '[FAKE_ALWAYS_EMPTY] do the task' });
  for (let i = 0; i < 80; i++) { const current = await manager.status(started.id); if (current.providerRecovery?.attempts >= 1) break; await delay(100); }
  const cancelledAt = Date.now();
  await manager.cancel(started.id);
  const status = await finished(manager, started.id, 100);
  assert.equal(status.status, 'cancelled', JSON.stringify(status));
  assert.ok(Date.now() - cancelledAt < 5000, 'cancel during backoff should stop well before the 15s delay elapses');
});

test('plain success still completes with providerRecovery.attempts 0, and set_auto_retry was sent after model selection', { timeout: 20000 }, async t => {
  const { manager, input } = await setupWorker(t, { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 200 });
  const started = await manager.start(input);
  const status = await finished(manager, started.id);
  assert.equal(status.status, 'completed', JSON.stringify(status));
  assert.equal(status.providerRecovery.attempts, 0);
  assert.equal(await fs.access(path.join(manager.jobDir(started.id), 'auto-retry-received.json')).then(() => true, () => false), true);
});

// =======================================================================
// real Pi 1.4.0 against a local mock OpenAI-compatible gateway
// =======================================================================

test('released Pi 1.4.0: empty finish_reason=stop completion recovers via a continuation prompt', { timeout: 60000 }, async t => {
  let requests = 0;
  const gateway = http.createServer(async (req, res) => {
    requests++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests === 1) {
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Recovered via real Pi.' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-provrec-real-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Local mock test only.\n'); git('add', '.'); git('commit', '-qm', 'base');
  const manager = await new Manager({ stateDir: path.join(root, 'state'), allowedRoots: [root], maxConcurrent: 1, defaultTimeoutSeconds: 30, maxTimeoutSeconds: 40, defaultMaxTurns: 4,
    piPath: process.execPath, piArgs: [cli], modelsFile: path.join(root, 'models.json'), allowedCommands: [],
    providerRecovery: { maxAttempts: 1, baseDelayMs: 200, maxDelayMs: 200 } },
    { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', MOCK_API_KEY: 'test-only-key' }).init();
  await fs.writeFile(path.join(root, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    models: [{ id: 'mock', name: 'Mock', contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const started = await manager.start({ repository, title: 'Real Pi recovery', prompt: 'Reply briefly.', provider: 'mock', model: 'mock' });
  const status = await finished(manager, started.id, 400);
  assert.equal(status.status, 'completed', JSON.stringify(status));
  assert.match((await manager.result(started.id)).result, /Recovered via real Pi/);
  assert.equal(status.providerRecovery.attempts, 1);
  assert.ok(requests >= 2);
});
