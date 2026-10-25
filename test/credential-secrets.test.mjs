// Focused unit test for collectConfigSecrets (src/headers.mjs), the pure
// credential walk extracted from worker.mjs's own redaction set and reused
// by Manager.patchSecretValues() so pi_patch sanitizes against exactly the
// same values. Pure function, no git/filesystem/Manager fixture needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectConfigSecrets } from '../src/headers.mjs';

test('a literal credential-shaped value is collected', () => {
  const config = { providers: { mock: { apiKey: 'literal-secret-value' } } };
  const secrets = collectConfigSecrets([config], {});
  assert.ok(secrets.includes('literal-secret-value'), JSON.stringify(secrets));
});

test('a ${ENV} reference is resolved against the given env, never the literal placeholder text', () => {
  const config = { providers: { mock: { apiKey: '${CORP_TOKEN}' } } };
  const secrets = collectConfigSecrets([config], { CORP_TOKEN: 'resolved-secret-xyz' });
  assert.ok(secrets.includes('resolved-secret-xyz'), JSON.stringify(secrets));
  assert.equal(secrets.some(value => value.includes('${CORP_TOKEN}')), false);
});

test('a short value nested under a "headers" map is kept regardless of its own key name or length', () => {
  const config = { providers: { mock: { headers: { 'X-Api-Key': 'ab' } } } };
  const secrets = collectConfigSecrets([config], {});
  assert.ok(secrets.includes('ab'), JSON.stringify(secrets));
});

test('a non-secret-named key is ignored even at a length that would otherwise qualify', () => {
  const config = { providers: { mock: { label: 'not-a-secret-but-long-enough' } } };
  const secrets = collectConfigSecrets([config], {});
  assert.equal(secrets.includes('not-a-secret-but-long-enough'), false);
});

test('a short non-secret-named, non-header value is ignored', () => {
  const config = { providers: { mock: { label: 'ab' } } };
  const secrets = collectConfigSecrets([config], {});
  assert.equal(secrets.includes('ab'), false);
});

test('multiple configs are walked independently, and a missing or null config is skipped rather than throwing', () => {
  const authConfig = { mock: { apiKey: 'auth-side-secret-value' } };
  const modelsConfig = { providers: { mock: { apiKey: 'models-side-secret-value' } } };
  const secrets = collectConfigSecrets([authConfig, null, undefined, modelsConfig], {});
  assert.ok(secrets.includes('auth-side-secret-value'), JSON.stringify(secrets));
  assert.ok(secrets.includes('models-side-secret-value'), JSON.stringify(secrets));
});

test('an empty or missing configs argument returns an empty array', () => {
  assert.deepEqual(collectConfigSecrets([], {}), []);
  assert.deepEqual(collectConfigSecrets(undefined, {}), []);
});
