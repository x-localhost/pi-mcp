import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateInternalProfile, validateInternalModels } from '../internal-agent/profile.mjs';

const profile = {
  piPath: '/usr/local/bin/node',
  piArgs: ['/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'],
  stateDir: '/var/lib/pi-mcp', allowedRoots: ['/workspace'],
  maxConcurrent: 2, defaultTimeoutSeconds: 1800, maxTimeoutSeconds: 7200,
  defaultMaxTurns: 30, provider: 'corporate', model: 'approved-model',
  modelsFile: '/etc/pi-internal/models.json', allowedCommands: [], envAllowlist: [],
};
const models = { providers: { corporate: {
  baseUrl: 'http://127.0.0.1:18080/v1', api: 'openai-completions',
  apiKey: 'pi-internal-placeholder', models: [{ id: 'approved-model', name: 'Approved model', contextWindow: 128000, maxTokens: 8192 }],
} } };

test('the fixed internal profile and matching single model are accepted', () => {
  assert.equal(validateInternalProfile(profile).model, 'approved-model');
  assert.equal(validateInternalModels(models, profile).providers.corporate.models[0].id, 'approved-model');
});

test('profile rejects host paths, alternate executables, secrets, and network knobs', () => {
  const bad = [
    { stateDir: '/host/state' }, { allowedRoots: ['/host/repo'] },
    { piPath: '/bin/sh' }, { piArgs: ['-c', 'id'] },
    { agentDir: '/home/user/.pi' }, { authFile: '/tmp/auth.json' },
    { envAllowlist: ['TOKEN'] }, { network: { httpsProxyEnv: 'HTTPS_PROXY' } },
    { modelsFile: '/tmp/models.json' }, { provider: 'other' },
    { extra: 'surprise' },
  ];
  for (const change of bad) assert.throws(() => validateInternalProfile({ ...profile, ...change }), undefined, JSON.stringify(change));
});

test('model file rejects nonloopback routing, injected credentials, extra providers and remote search', () => {
  const changes = [
    { baseUrl: 'https://example.com/v1' }, { api: 'openai-responses' },
    { apiKey: '$SECRET' }, { headers: { Authorization: 'Bearer $TOKEN' } },
    { models: [{ id: 'other' }] }, { search: true },
  ];
  for (const change of changes) {
    const candidate = structuredClone(models);
    Object.assign(candidate.providers.corporate, change);
    assert.throws(() => validateInternalModels(candidate, profile), undefined, JSON.stringify(change));
  }
  assert.throws(() => validateInternalModels({ providers: { ...models.providers, extra: models.providers.corporate } }, profile));
});

test('compose/image admission contract excludes host mounts and exposed ports', () => {
  const compose = readFileSync(new URL('../internal-agent/compose.yaml', import.meta.url), 'utf8');
  const image = readFileSync(new URL('../internal-agent/Dockerfile', import.meta.url), 'utf8');
  assert.match(compose, /network_mode:\s*none/);
  assert.match(compose, /cap_drop:\s*\[ALL\]/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /user:\s*["']?1000:1000/);
  assert.doesNotMatch(compose, /\b(?:ports|privileged|network_mode:\s*host):/);
  assert.match(image, /npm ci --ignore-scripts/);
  assert.match(image, /USER 1000:1000/);
});
