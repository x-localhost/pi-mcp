// RED suite for corporate LLM custom-header validation (docs/corporate-headers-plan.md).
// Exercises Manager.start() so validation ordering (before job/worktree/network side
// effects) is covered, not just a bare throw. No implementation exists yet; every
// "must reject" case below is expected to currently fail because Manager.start()
// accepts the job today.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Manager } from '../src/manager.mjs';

async function repoSetup(prefix) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const repository = path.join(tmp, 'repo');
  await fs.mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Header validation test.');
  git('add', '.'); git('commit', '-qm', 'base');
  return { tmp, repository };
}

async function makeManager(tmp, providers, childEnv = {}, authConfig = null) {
  const modelsFile = path.join(tmp, 'models.json');
  await fs.writeFile(modelsFile, JSON.stringify({ providers }));
  const config = { stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 2,
    defaultTimeoutSeconds: 30, maxTimeoutSeconds: 60, defaultMaxTurns: 2, piPath: '/bin/true', allowedCommands: [], modelsFile };
  if (authConfig) { const authFile = path.join(tmp, 'auth.json'); await fs.writeFile(authFile, JSON.stringify(authConfig)); config.authFile = authFile; }
  return new Manager(config, childEnv, { spawnWorker: false }).init();
}

function worktreeCount(repository) {
  const output = execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  return output.split('\n').filter(line => line.startsWith('worktree ')).length;
}

async function assertRejectsBeforeSideEffects(manager, repository, input, pattern) {
  const beforeJobs = (await fs.readdir(manager.jobsDir).catch(() => [])).sort();
  const beforeWorktrees = worktreeCount(repository);
  await assert.rejects(manager.start(input), pattern);
  const afterJobs = (await fs.readdir(manager.jobsDir).catch(() => [])).sort();
  assert.deepEqual(afterJobs, beforeJobs, 'header validation must reject before a job directory is created');
  assert.equal(worktreeCount(repository), beforeWorktrees, 'header validation must reject before a worktree is created');
}

const baseInput = { title: 'Header test', prompt: 'Say hello.', provider: 'corp', model: 'corp-model' };
const baseModel = { id: 'corp-model', name: 'Corp model', contextWindow: 8192, maxTokens: 512 };

const invalidProviderHeaderCases = [
  ['rejects a header name containing whitespace', { 'Bad Header': 'value' }, {}, /header/i],
  ['rejects an empty header name', { '': 'value' }, {}, /header/i],
  ['rejects a header value containing CRLF (response-splitting)', { 'X-Corp-Trace': 'abc\r\nX-Injected: evil' }, {}, /header/i],
  ['rejects a header value containing a control byte', { 'X-Corp-Trace': 'abc\x01def' }, {}, /header/i],
  ['rejects a non-string header value (number)', { 'X-Corp-Trace': 123 }, {}, /header/i],
  ['rejects a non-string header value (object)', { 'X-Corp-Trace': { nested: true } }, {}, /header/i],
  ['rejects a command-bearing header value reaching Manager.start without leaving side effects', { Authorization: '!echo leak' }, {}, /Command-bearing credential/],
  ['rejects a plain $NAME reference missing from the forwarded child environment', { 'X-Corp-Token': '$CORP_MISSING_TOKEN' }, {}, /CORP_MISSING_TOKEN|environment/i],
  ['rejects a plain $NAME reference present but empty in the forwarded child environment', { 'X-Corp-Token': '$CORP_EMPTY_TOKEN' }, { CORP_EMPTY_TOKEN: '' }, /CORP_EMPTY_TOKEN|environment/i],
  ['rejects a braced ${NAME} reference missing from the forwarded child environment', { 'X-Corp-Token': '${CORP_MISSING_BRACED}' }, {}, /CORP_MISSING_BRACED|environment/i],
  ['rejects a ${NAME} reference embedded in a larger value', { Authorization: 'Bearer ${CORP_MISSING_EMBED}' }, {}, /CORP_MISSING_EMBED|environment/i],
  ['rejects a $NAME reference embedded in a larger value', { Authorization: 'prefix-$CORP_MISSING_EMBED-suffix' }, {}, /CORP_MISSING_EMBED|environment/i],
];

for (const [name, headers, childEnv, pattern] of invalidProviderHeaderCases) {
  test(`provider headers: ${name}`, async () => {
    const { tmp, repository } = await repoSetup('pi-headers-provider-');
    const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY', headers, models: [baseModel] } }, childEnv);
    await assertRejectsBeforeSideEffects(manager, repository, { ...baseInput, repository }, pattern);
  });
}

test('model-level (modelOverrides) headers: rejects an invalid header on the selected model', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-model-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    models: [{ ...baseModel, headers: { 'X-Corp-Model': '$CORP_MODEL_MISSING' } }] } }, {});
  await assertRejectsBeforeSideEffects(manager, repository, { ...baseInput, repository }, /CORP_MODEL_MISSING|environment/i);
});

test('model-level (modelOverrides) headers: rejects a CRLF value on the selected model even when provider headers are valid', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-model-crlf-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    headers: { 'X-Corp-Client': '$CORP_CLIENT_ID' },
    models: [{ ...baseModel, headers: { 'X-Corp-Model': 'abc\r\nX-Injected: evil' } }] } }, { CORP_CLIENT_ID: 'client-1' });
  await assertRejectsBeforeSideEffects(manager, repository, { ...baseInput, repository }, /header/i);
});

test('rejected header validation never echoes a real secret value in the thrown error', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-secret-');
  const secret = 'company-private-credential';
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions',
    apiKey: '$CORP_REAL_TOKEN', headers: { Authorization: '$CORP_REAL_TOKEN', 'X-Corp-Trace': 'abc\r\nX-Injected: evil' }, models: [baseModel] } },
    { CORP_REAL_TOKEN: secret });
  let caught;
  try { await manager.start({ ...baseInput, repository }); } catch (error) { caught = error; }
  assert.ok(caught, 'expected Manager.start to reject');
  assert.equal(caught.message.includes(secret), false, 'thrown error must not contain the resolved secret value');
});

test('seeded header configuration is revalidated on a later submission after the environment loses a referenced value', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-reval-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    headers: { 'X-Corp-Token': '$CORP_ROTATING_TOKEN' }, models: [baseModel] } }, { CORP_ROTATING_TOKEN: 'present-for-now' });
  const first = await manager.start({ ...baseInput, repository, title: 'First submission' });
  assert.equal(first.status, 'starting');
  delete manager.childEnv.CORP_ROTATING_TOKEN;
  await assertRejectsBeforeSideEffects(manager, repository, { ...baseInput, repository, title: 'Second submission' }, /CORP_ROTATING_TOKEN|environment/i);
});

// Forward guards for Pi's exact escape grammar: these assertions hold vacuously today
// (no header validation exists yet) but are written now so a naive $NAME-detecting
// regex cannot regress them once GREEN lands. $$ escapes to a literal "$" in Pi 1.4.0
// header/apiKey interpolation, and "$!" can never match the $NAME/${NAME} grammar
// (identifiers cannot start with "!"), so neither must be treated as an unresolved
// environment reference. Exact Pi 1.4.0 escape semantics are otherwise unverified
// locally (no network/install access in this phase); confirm against the installed
// package on gram before relying on this beyond the "not a reference" guarantee.
test('an escaped $$ literal is not treated as a missing environment reference', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-escape-dollar-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    headers: { 'X-Corp-Literal': '$$CORP_NOT_A_REFERENCE' }, models: [baseModel] } }, {});
  const started = await manager.start({ ...baseInput, repository });
  assert.equal(started.status, 'starting');
});

test('a "$!" sequence is not treated as a missing environment reference', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-escape-bang-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    headers: { 'X-Corp-Literal': 'retry$!attempt' }, models: [baseModel] } }, {});
  const started = await manager.start({ ...baseInput, repository });
  assert.equal(started.status, 'starting');
});

test('valid headers with present, non-empty referenced environment variables are accepted', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-valid-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    headers: { 'X-Corp-Client': '$CORP_CLIENT_ID', 'X-Corp-Trace': 'trace-${CORP_TRACE_ID}' },
    models: [{ ...baseModel, headers: { 'X-Corp-Model': '$CORP_MODEL_TOKEN' } }] } },
    { MOCK_API_KEY: 'test-only-key', CORP_CLIENT_ID: 'client-1', CORP_TRACE_ID: 'trace-1', CORP_MODEL_TOKEN: 'model-token' });
  const started = await manager.start({ ...baseInput, repository });
  assert.equal(started.status, 'starting');
});

test('an unused provider with a missing referenced environment variable does not block an unrelated job', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-unused-provider-');
  const manager = await makeManager(tmp, {
    corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY', models: [baseModel] },
    other: { baseUrl: 'https://other.invalid/v1', api: 'openai-completions', apiKey: '$OTHER_API_KEY',
      headers: { 'X-Other-Token': '$OTHER_MISSING_TOKEN' }, models: [{ id: 'other-model', name: 'Other', contextWindow: 8192, maxTokens: 512 }] },
  }, {});
  const started = await manager.start({ ...baseInput, repository });
  assert.equal(started.status, 'starting');
});

test('a resolved environment value containing CRLF is rejected even though the template itself is syntactically valid', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-resolved-crlf-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    headers: { 'X-Corp-Trace': '$CORP_INJECTED' }, models: [baseModel] } }, { CORP_INJECTED: 'abc\r\nX-Injected: evil' });
  await assertRejectsBeforeSideEffects(manager, repository, { ...baseInput, repository }, /header|control character/i);
});

test('an environment value is not recursively re-parsed for further references', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-no-recursion-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    headers: { 'X-Corp-Trace': '$CORP_OUTER' }, models: [baseModel] } }, { CORP_OUTER: '$CORP_INNER_NEVER_RESOLVED' });
  const started = await manager.start({ ...baseInput, repository });
  assert.equal(started.status, 'starting');
});

test('an api_key auth.json credential env overlays the forwarded child environment for both provider and model headers', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-apikey-overlay-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions', apiKey: '$MOCK_API_KEY',
    headers: { 'X-Corp-Provider-Token': '$CORP_CRED_ONLY' },
    models: [{ ...baseModel, headers: { 'X-Corp-Model-Token': '$CORP_CRED_ONLY' } }] } }, {},
    { corp: { type: 'api_key', key: 'unused', env: { CORP_CRED_ONLY: 'from-auth-json' } } });
  const started = await manager.start({ ...baseInput, repository });
  assert.equal(started.status, 'starting');
});

test('an oauth auth.json credential env overlays provider headers only; model headers still require the child environment', async () => {
  const { tmp, repository } = await repoSetup('pi-headers-oauth-scope-');
  const manager = await makeManager(tmp, { corp: { baseUrl: 'https://llm.corp.invalid/v1', api: 'openai-completions',
    headers: { 'X-Corp-Provider-Token': '$CORP_OAUTH_ONLY' },
    models: [{ ...baseModel, headers: { 'X-Corp-Model-Token': '$CORP_OAUTH_ONLY' } }] } }, {},
    { corp: { type: 'oauth', access: 'unused-access', refresh: 'unused-refresh', expires: 0, env: { CORP_OAUTH_ONLY: 'from-auth-json' } } });
  // The provider-level header resolves from the oauth credential's env overlay,
  // but the model-level header must not: it only sees the forwarded child
  // environment, which lacks CORP_OAUTH_ONLY, so the job is still rejected.
  await assertRejectsBeforeSideEffects(manager, repository, { ...baseInput, repository }, /CORP_OAUTH_ONLY|environment/i);
});

test('a short (3-character) header-sourced secret is redacted from public and private result despite the generic length floor', { timeout: 20000 }, async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
  await fs.chmod(fake, 0o755);
  const { tmp, repository } = await repoSetup('pi-headers-short-secret-');
  const secret = 'zq7';
  const manager = await makeManager(tmp, { mock: { headers: { Authorization: '${CORP_SESSION}' } } },
    { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', FAKE_PI_SCENARIO: 'secret_error', CORP_SESSION: secret });
  manager.config.piPath = fake; manager.spawnWorker = true;
  const started = await manager.start({ ...baseInput, repository, provider: 'mock', model: 'mock' });
  let status;
  for (let i = 0; i < 150; i++) {
    status = await manager.status(started.id);
    if (!['starting', 'running'].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status.status, 'failed');
  assert.equal(JSON.stringify(status).includes(secret), false);
  const result = await manager.result(started.id);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const privateResult = await fs.readFile(path.join(manager.jobDir(started.id), 'result.txt'), 'utf8');
  assert.equal(privateResult.includes(secret), false);
});
