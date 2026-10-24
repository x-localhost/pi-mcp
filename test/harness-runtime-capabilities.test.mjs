import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilities } from '../src/capabilities.mjs';
import { validateOfflineConfig } from '../src/offline-materials.mjs';

test('capabilities disclose safe IDs, modes, contracts and limits without private executable configuration', () => {
  const config = { provider: 'mock', model: 'small', maxConcurrent: 2, maxTimeoutSeconds: 90, defaultMaxTurns: 4,
    verification: { maxSelected: 2, commands: [{ id: 'lint', description: 'Lint source', argv: ['/opt/private/grader'], readOnly: true }] },
    offlineMaterials: { materials: [{ id: 'fixture', description: 'Offline fixture', manifestPath: '/secret/material' }] },
    approvedMcp: { servers: [{ id: 'safe', tools: [{ name: 'lookup', description: 'Find a record' }], reviewTools: ['lookup'], env: { MCP_SECRET: 'secret' } }] },
    context: { maxMessages: 112, maxBytes: 3500000 }, observation: { maxEvents: 256, maxBytes: 65536, idleTimeoutMs: 0, consecutiveFailureLimit: 0 } };
  const result = capabilities(config);
  assert.equal(result.version, 1);
  assert.deepEqual(result.models, [{ provider: 'mock', model: 'small' }]);
  assert.equal(result.verifiers[0].description, 'Lint source');
  assert.equal(result.materials[0].description, 'Offline fixture');
  assert.ok(result.tools.review.some(item => item.name === 'mcp__safe__lookup'));
  assert.match(JSON.stringify(result), /acceptance/);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|grader|manifestPath|argv|MCP_SECRET/);
});

test('administrator material descriptions are bounded and preserved for discovery', () => {
  const material = { id: 'fixture', description: 'Offline fixture', manifestPath: 'fixture.json', manifestSha256: 'a'.repeat(64), baseCommit: 'b'.repeat(40), destination: 'fixture' };
  const normalized = validateOfflineConfig({ materials: [material] }, '/config');
  assert.equal(normalized.materials[0].description, 'Offline fixture');
  assert.throws(() => validateOfflineConfig({ materials: [{ ...material, description: 'x'.repeat(201) }] }, '/config'), /description/);
});
