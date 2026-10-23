import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, chmod, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(root, 'scripts/check-internal-agent.py');
const examples = path.join(root, 'internal-agent');

async function preflight({ maxTokens, limits }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-internal-cap-'));
  try {
    const files = {
      PI_INTERNAL_CONFIG_FILE: path.join(dir, 'config.json'),
      PI_INTERNAL_MODELS_FILE: path.join(dir, 'models.json'),
      PI_INTERNAL_GATEWAY_CONFIG_FILE: path.join(dir, 'gateway.json'),
      PI_INTERNAL_CA_FILE: path.join(dir, 'ca.pem'),
      PI_INTERNAL_GATEWAY_ENV_FILE: path.join(dir, 'gateway.env'),
    };
    const config = JSON.parse(await readFile(path.join(examples, 'config.example.json'), 'utf8'));
    const models = JSON.parse(await readFile(path.join(examples, 'models.example.json'), 'utf8'));
    const gateway = JSON.parse(await readFile(path.join(examples, 'gateway.example.json'), 'utf8'));
    if (maxTokens !== undefined) models.providers.corporate.models[0].maxTokens = maxTokens;
    if (limits !== undefined) gateway.limits = limits;
    for (const [key, value] of Object.entries({
      [files.PI_INTERNAL_CONFIG_FILE]: config,
      [files.PI_INTERNAL_MODELS_FILE]: models,
      [files.PI_INTERNAL_GATEWAY_CONFIG_FILE]: gateway,
    })) await writeFile(key, JSON.stringify(value));
    await writeFile(files.PI_INTERNAL_CA_FILE, 'fixture');
    await writeFile(files.PI_INTERNAL_GATEWAY_ENV_FILE, 'CORP_LLM_API_KEY=test\nCORP_CLIENT_ID=test\n');
    await chmod(files.PI_INTERNAL_GATEWAY_ENV_FILE, 0o600);
    execFileSync('python3', [checker, '--project', 'model-cap-test', '--preflight-only'], {
      env: { ...process.env, ...files }, stdio: 'pipe',
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('committed model and gateway examples pass the real preflight at equal caps', async () => {
  const result = await preflight({});
  assert.equal(result.ok, true, result.output);
});

test('preflight accepts lower, equal, and default gateway output caps', async () => {
  for (const [maxTokens, limits] of [
    [2048, { maxOutputTokens: 4096 }],
    [4096, { maxOutputTokens: 4096 }],
    [4096, {}],
  ]) assert.equal((await preflight({ maxTokens, limits })).ok, true);
});

test('preflight rejects a model cap above gateway cap and invalid caps', async () => {
  for (const [maxTokens, limits] of [
    [8192, { maxOutputTokens: 4096 }],
    [0, { maxOutputTokens: 4096 }],
    [true, { maxOutputTokens: 4096 }],
    [1.5, { maxOutputTokens: 4096 }],
    [4096, { maxOutputTokens: 0 }],
    [4096, { maxOutputTokens: 16385 }],
    [4096, { maxOutputTokens: 1.5 }],
    [4096, { maxOutputTokens: true }],
    [4096, []],
  ]) assert.equal((await preflight({ maxTokens, limits })).ok, false);
});
