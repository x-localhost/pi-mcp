import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInternalProfile, validateInternalModels } from '../internal-agent/profile.mjs';

const profile = { piPath: '/usr/local/bin/node', piArgs: ['/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'], stateDir: '/var/lib/pi-mcp', allowedRoots: ['/workspace'], maxConcurrent: 2,
  defaultTimeoutSeconds: 1800, maxTimeoutSeconds: 7200, defaultMaxTurns: 30, provider: 'corporate', model: 'approved-model', modelsFile: '/etc/pi-internal/models.json', allowedCommands: [], envAllowlist: [] };
const models = input => ({ providers: { corporate: { baseUrl: 'http://127.0.0.1:18080/v1', api: 'openai-completions', apiKey: 'pi-internal-placeholder', models: [{ id: 'approved-model', name: 'Approved', contextWindow: 8192, maxTokens: 512, ...(input === undefined ? {} : { input }) }] } } });

test('internal model defaults to text and permits explicit text plus image', () => {
  const checked = validateInternalProfile(profile);
  assert.deepEqual(validateInternalModels(models(), checked), models());
  assert.deepEqual(validateInternalModels(models(['text']), checked), models(['text']));
  assert.deepEqual(validateInternalModels(models(['text', 'image']), checked), models(['text', 'image']));
  for (const invalid of [[], ['image'], ['text', 'audio'], ['image', 'text'], ['text', 'image', 'image']]) {
    assert.throws(() => validateInternalModels(models(invalid), checked));
  }
});

test('internal profile admits normalized approved MCP only and rejects unknown fields', () => {
  assert.deepEqual(validateInternalProfile({ ...profile, approvedMcp: { servers: [] } }).approvedMcp, { servers: [] });
  assert.throws(() => validateInternalProfile({ ...profile, approvedMcp: { servers: [], arbitraryRoute: 'https://outside.invalid' } }));
  assert.throws(() => validateInternalProfile({ ...profile, unsupported: true }));
});
