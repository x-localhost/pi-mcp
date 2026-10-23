import fs from 'node:fs/promises';
import { validateApprovedMcp } from '../src/approved-mcp.mjs';

const PI_CLI = '/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const PROFILE_KEYS = new Set(['piPath', 'piArgs', 'stateDir', 'allowedRoots', 'maxConcurrent', 'defaultTimeoutSeconds', 'maxTimeoutSeconds', 'defaultMaxTurns', 'provider', 'model', 'modelsFile', 'allowedCommands', 'envAllowlist', 'queue', 'verification', 'budgets', 'retention', 'artifacts', 'approvedMcp', 'offlineMaterials']);
const PROVIDER_KEYS = new Set(['baseUrl', 'api', 'apiKey', 'models']);
const MODEL_KEYS = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input']);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}
function exactKeys(value, allowed, name) {
  object(value, name);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name} has forbidden field ${key}`);
}
function exact(value, expected, name) {
  if (value !== expected) throw new Error(`${name} must be ${expected}`);
}
function boundedInt(value, low, high, name) {
  if (!Number.isInteger(value) || value < low || value > high) throw new Error(`${name} is out of bounds`);
}

export function validateInternalProfile(raw) {
  exactKeys(raw, PROFILE_KEYS, 'profile');
  exact(raw.piPath, '/usr/local/bin/node', 'piPath');
  if (JSON.stringify(raw.piArgs) !== JSON.stringify([PI_CLI])) throw new Error('piArgs must be the packaged Pi CLI');
  exact(raw.stateDir, '/var/lib/pi-mcp', 'stateDir');
  if (JSON.stringify(raw.allowedRoots) !== JSON.stringify(['/workspace'])) throw new Error('allowedRoots must be the private workspace');
  exact(raw.provider, 'corporate', 'provider');
  if (typeof raw.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(raw.model)) throw new Error('invalid model');
  exact(raw.modelsFile, '/etc/pi-internal/models.json', 'modelsFile');
  boundedInt(raw.maxConcurrent, 1, 4, 'maxConcurrent');
  boundedInt(raw.defaultTimeoutSeconds, 10, 3600, 'defaultTimeoutSeconds');
  boundedInt(raw.maxTimeoutSeconds, raw.defaultTimeoutSeconds, 7200, 'maxTimeoutSeconds');
  boundedInt(raw.defaultMaxTurns, 1, 100, 'defaultMaxTurns');
  if (!Array.isArray(raw.allowedCommands) || raw.allowedCommands.some(x => typeof x !== 'string' || !x || x.length > 512)) throw new Error('invalid allowedCommands');
  if (JSON.stringify(raw.envAllowlist) !== '[]') throw new Error('envAllowlist must be empty');
  for (const key of ['queue', 'verification', 'budgets', 'retention', 'artifacts', 'offlineMaterials']) if (raw[key] !== undefined) object(raw[key], key);
  return raw.approvedMcp === undefined ? raw : { ...raw, approvedMcp: validateApprovedMcp(raw.approvedMcp) };
}

export function validateInternalModels(raw, profile) {
  exactKeys(raw, new Set(['providers']), 'models');
  exactKeys(raw.providers, new Set(['corporate']), 'providers');
  const provider = raw.providers.corporate;
  exactKeys(provider, PROVIDER_KEYS, 'corporate provider');
  exact(provider.baseUrl, 'http://127.0.0.1:18080/v1', 'baseUrl');
  exact(provider.api, 'openai-completions', 'api');
  exact(provider.apiKey, 'pi-internal-placeholder', 'apiKey');
  if (!Array.isArray(provider.models) || provider.models.length !== 1) throw new Error('exactly one model is required');
  const model = provider.models[0];
  exactKeys(model, MODEL_KEYS, 'model');
  exact(model.id, profile.model, 'model id');
  if (typeof model.name !== 'string' || !model.name || model.name.length > 128) throw new Error('invalid model name');
  boundedInt(model.contextWindow, 1024, 1000000, 'contextWindow');
  boundedInt(model.maxTokens, 1, model.contextWindow, 'maxTokens');
  if (model.input !== undefined && JSON.stringify(model.input) !== '["text"]' && JSON.stringify(model.input) !== '["text","image"]') throw new Error('model input must be text or text plus image');
  return raw;
}

export async function loadAndValidateProfile() {
  for (const target of ['/etc/pi-internal/config.json', '/etc/pi-internal/models.json']) {
    if (!(await fs.lstat(target)).isFile()) throw new Error(`${target} must be a regular file`);
  }
  const profile = validateInternalProfile(JSON.parse(await fs.readFile('/etc/pi-internal/config.json', 'utf8')));
  validateInternalModels(JSON.parse(await fs.readFile('/etc/pi-internal/models.json', 'utf8')), profile);
  return profile;
}
