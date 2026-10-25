// pi-mcp corporate configuration unit.
//
// Exports (contract, see docs/plan.md and test/config.test.mjs):
//   loadConfig(file = process.env.PI_MCP_CONFIG)        -> Promise<Config>
//   validateConfig(raw, configDir)                       -> Config
//   buildChildEnv(config, source = process.env)          -> Record<string, string>
//   redact(value, sourceEnv = process.env)                -> same shape, secrets masked
//   healthConfig(config, source = process.env)            -> plain status object
//
// Design notes (see docs/config-unit-report.md for the full rationale):
// - piPath/stateDir/allowedRoots must already be absolute; agentDir,
//   modelsFile, authFile, and network.caFile may be relative and are
//   resolved against configDir.
// - Unknown top-level/network fields fail closed.
// - envAllowlist rejects names that would let corporate config override
//   process-wide/TLS/dynamic-loader/git-config/Pi-internal behavior; the
//   dedicated network.* fields remain the only path for proxy/CA/registry.
// - buildChildEnv never widens TLS trust and never leaks unlisted source
//   vars; redact never returns real secret values, even in error text.

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { validateArtifactConfig } from './artifacts.mjs';
import { validateOfflineConfig } from './offline-materials.mjs';
import { validateApprovedMcp } from './approved-mcp.mjs';
import { normalizeContext } from './context-policy.mjs';
import { normalizeObservation } from './observation.mjs';

const REDACTED = '[REDACTED]';

const NETWORK_FIELDS = ['httpProxyEnv', 'httpsProxyEnv', 'allProxyEnv', 'noProxyEnv', 'caFile', 'npmRegistry'];

const TOP_LEVEL_FIELDS = [
  'piPath',
  'piArgs',
  'stateDir',
  'allowedRoots',
  'maxConcurrent',
  'defaultTimeoutSeconds',
  'maxTimeoutSeconds',
  'defaultMaxTurns',
  'provider',
  'model',
  'thinkingLevel',
  'agentDir',
  'modelsFile',
  'authFile',
  'allowedCommands',
  'envAllowlist',
  'network',
  'queue', 'verification', 'budgets', 'retention', 'artifacts', 'offlineMaterials', 'approvedMcp', 'context', 'observation', 'providerRecovery',
];

function strictObject(raw, allowed, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(label, 'must be an object');
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(label, `unknown field "${key}"`);
}
function bounded(raw, name, fallback, min, max, label) {
  const value = raw[name] === undefined ? fallback : raw[name];
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}.${name}`, `must be an integer between ${min} and ${max}`);
  return value;
}
function normalizeQueue(raw = {}) {
  strictObject(raw, ['maxPending', 'maxWaitSeconds', 'dispatchIntervalMs'], 'queue');
  return { maxPending: bounded(raw, 'maxPending', 16, 1, 64, 'queue'), maxWaitSeconds: bounded(raw, 'maxWaitSeconds', 3600, 10, 86400, 'queue'), dispatchIntervalMs: bounded(raw, 'dispatchIntervalMs', 500, 100, 5000, 'queue') };
}
function normalizeVerification(raw = {}) {
  strictObject(raw, ['commands', 'maxSelected'], 'verification');
  const commands = raw.commands === undefined ? [] : raw.commands;
  if (!Array.isArray(commands) || commands.length > 32) fail('verification.commands', 'invalid command list');
  const ids = new Set();
  const normalized = commands.map(item => {
    strictObject(item, ['id', 'description', 'argv', 'timeoutSeconds', 'maxOutputBytes', 'readOnly', 'protectedFiles'], 'verification.commands');
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(item.id || '') || ids.has(item.id)) fail('verification.commands', 'invalid or duplicate command id');
    ids.add(item.id);
    if (!Array.isArray(item.argv) || item.argv.length < 1 || item.argv.length > 16 || item.argv.some(value => typeof value !== 'string' || !value || value.length > 512 || /[\0\r\n]/.test(value)) || !path.isAbsolute(item.argv[0]) || path.normalize(item.argv[0]) !== item.argv[0] || item.argv[0].split('/').some(part => part === '.' || part === '..') || !['/usr/bin', '/bin', '/usr/local/bin', '/opt/project-tools'].some(root => item.argv[0].startsWith(root + '/'))) fail('verification.commands', 'argv must pin an image-packaged absolute executable and bounded arguments');
    if (item.readOnly !== undefined && typeof item.readOnly !== 'boolean') fail('verification.commands.readOnly', 'must be boolean');
    if (item.description !== undefined && (typeof item.description !== 'string' || !item.description.trim() || item.description.length > 200)) fail('verification.commands.description', 'invalid description');
    if (item.protectedFiles !== undefined && (!Array.isArray(item.protectedFiles) || item.protectedFiles.length > 32 || item.protectedFiles.some(file => !file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['path', 'sha256'].includes(key)) || typeof file.path !== 'string' || !path.isAbsolute(file.path) || path.normalize(file.path) !== file.path || !file.path.startsWith('/opt/project-tools/') || !/^[0-9a-f]{64}$/.test(file.sha256)))) fail('verification.commands.protectedFiles', 'invalid packaged file hashes');
    if (item.protectedFiles?.length && !item.argv.some(arg => item.protectedFiles.some(file => file.path === arg))) fail('verification.commands.protectedFiles', 'must include the declared script or executable');
    if (item.protectedFiles?.length && item.argv.filter(arg => arg.startsWith('/opt/project-tools/')).some(arg => !item.protectedFiles.some(file => file.path === arg))) fail('verification.commands.protectedFiles', 'all packaged argv files must be pinned');
    return { id: item.id, description: item.description || '', argv: [...item.argv], protectedFiles: item.protectedFiles || [], timeoutSeconds: bounded(item, 'timeoutSeconds', 300, 1, 3600, 'verification.commands'), maxOutputBytes: bounded(item, 'maxOutputBytes', 65536, 1, 1048576, 'verification.commands'), readOnly: item.readOnly === true };
  });
  return { commands: normalized, maxSelected: bounded(raw, 'maxSelected', 4, 1, 8, 'verification') };
}
function normalizeBudgets(raw = {}) {
  strictObject(raw, ['maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxCostUsd'], 'budgets');
  const result = {};
  for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxTotalTokens']) if (raw[key] !== undefined) result[key] = bounded(raw, key, null, 1, 10000000, 'budgets');
  if (raw.maxCostUsd !== undefined) {
    if (typeof raw.maxCostUsd !== 'number' || !Number.isFinite(raw.maxCostUsd) || raw.maxCostUsd <= 0 || raw.maxCostUsd > 10000) fail('budgets.maxCostUsd', 'invalid bound');
    result.maxCostUsd = raw.maxCostUsd;
  }
  return result;
}
function normalizeRetention(raw = {}) {
  strictObject(raw, ['maxStateBytes', 'maxScanEntries', 'terminalDays'], 'retention');
  return { maxStateBytes: bounded(raw, 'maxStateBytes', 4 * 1024 * 1024 * 1024, 1048576, 1024 * 1024 * 1024 * 1024, 'retention'),
    maxScanEntries: bounded(raw, 'maxScanEntries', 100000, 100, 1000000, 'retention'), terminalDays: bounded(raw, 'terminalDays', 30, 0, 3650, 'retention') };
}
// maxAttempts: 0 disables the worker's bounded continuation-prompt recovery
// (see src/provider-recovery.mjs and docs/provider-resilience.md) entirely;
// maxDelayMs must be at least baseDelayMs so the exponential backoff never
// inverts.
function normalizeProviderRecovery(raw = {}) {
  strictObject(raw, ['maxAttempts', 'baseDelayMs', 'maxDelayMs'], 'providerRecovery');
  const maxAttempts = bounded(raw, 'maxAttempts', 2, 0, 5, 'providerRecovery');
  const baseDelayMs = bounded(raw, 'baseDelayMs', 5000, 0, 120000, 'providerRecovery');
  const maxDelayMs = bounded(raw, 'maxDelayMs', 60000, 0, 600000, 'providerRecovery');
  if (maxDelayMs < baseDelayMs) fail('providerRecovery.maxDelayMs', 'must be greater than or equal to baseDelayMs');
  return { maxAttempts, baseDelayMs, maxDelayMs };
}
export function validateCompletionSections(raw = {}, configDir = '/') {
  strictObject(raw, TOP_LEVEL_FIELDS, 'completion');
  const section = (name) => raw[name] === undefined ? {} : raw[name];
  return { queue: normalizeQueue(section('queue')), verification: normalizeVerification(section('verification')),
    budgets: normalizeBudgets(section('budgets')), retention: normalizeRetention(section('retention')),
    artifacts: validateArtifactConfig(section('artifacts')), offlineMaterials: validateOfflineConfig(section('offlineMaterials'), configDir),
    approvedMcp: validateApprovedMcp(raw.approvedMcp), context: normalizeContext(raw.context), observation: normalizeObservation(raw.observation),
    providerRecovery: normalizeProviderRecovery(section('providerRecovery')) };
}

// Names that must never be reachable through the generic envAllowlist,
// because they are either managed exclusively by the dedicated network.*
// fields, or are process-wide/TLS/dynamic-loader/git-config/Pi-internal
// injection vectors.
const RESERVED_ENV_EXACT = new Set([
  'PATH',
  'HOME',
  'SSH_AUTH_SOCK',
  'ENV',
  'BASH_ENV',
  'GIT_SSL_CAINFO',
  'GIT_SSL_NO_VERIFY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NPM_CONFIG_CAFILE',
  'NPM_CONFIG_REGISTRY',
  'NPM_CONFIG_STRICT_SSL',
]);
const RESERVED_ENV_PREFIXES = ['NODE_', 'LD_', 'DYLD_', 'PI_', 'GIT_CONFIG_'];

function isReservedEnvName(name) {
  const upper = name.toUpperCase();
  if (RESERVED_ENV_EXACT.has(upper)) return true;
  return RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

// Credential-like key names (case-insensitive substring match), covering
// generic secrets as well as OAuth-style access/refresh tokens.
const SECRET_KEY_PATTERN = /secret|password|passwd|token|api[-_]?key|access[-_]?key|auth|credential|private[-_]?key/i;

function fail(field, message) {
  throw new Error(`config.${field}: ${message}`);
}

function requireAbsolutePath(raw, field) {
  const value = raw[field];
  if (typeof value !== 'string' || value === '') {
    fail(field, 'must be a non-empty absolute path string');
  }
  if (!path.isAbsolute(value)) {
    fail(field, 'must be an absolute path');
  }
  return value;
}

function requireAllowedRoots(raw) {
  const value = raw.allowedRoots;
  if (!Array.isArray(value) || value.length === 0) {
    fail('allowedRoots', 'must be a non-empty array of absolute paths');
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry)) {
      fail('allowedRoots', 'every entry must be an absolute path string');
    }
  }
  return [...value];
}

function normalizeStringArray(raw, key, fallback, label = key) {
  if (!(key in raw) || raw[key] === undefined) return [...fallback];
  const value = raw[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(label, 'must be an array of strings');
  }
  return [...value];
}

function normalizeEnvAllowlist(raw) {
  const names = normalizeStringArray(raw, 'envAllowlist', []);
  for (const name of names) {
    if (isReservedEnvName(name)) {
      fail('envAllowlist', `"${name}" is a reserved/dangerous environment variable name and cannot be allowlisted`);
    }
  }
  return names;
}

function normalizeIntRange(raw, key, fallback, min, max) {
  if (!(key in raw) || raw[key] === undefined) return fallback;
  const value = raw[key];
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(key, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizePositiveInt(raw, key, fallback) {
  if (!(key in raw) || raw[key] === undefined) return fallback;
  const value = raw[key];
  if (!Number.isInteger(value) || value <= 0) {
    fail(key, 'must be a positive integer');
  }
  return value;
}

function normalizeOptionalString(raw, key, label = key) {
  if (!(key in raw) || raw[key] === null || raw[key] === undefined) return null;
  const value = raw[key];
  if (typeof value !== 'string' || value === '') {
    fail(label, 'must be a non-empty string when set');
  }
  return value;
}

function normalizeOptionalPath(raw, key, configDir, label = key) {
  const value = normalizeOptionalString(raw, key, label);
  if (value === null) return null;
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function validateNpmRegistry(raw) {
  if (typeof raw !== 'string' || raw === '') {
    fail('network.npmRegistry', 'must be a non-empty string');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('network.npmRegistry', 'must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('network.npmRegistry', 'must use http or https');
  }
  if (url.username || url.password) {
    fail('network.npmRegistry', 'must not embed credentials; use existing npm credential configuration instead');
  }
  return raw;
}

function normalizeNetwork(rawNetwork, configDir) {
  const value = rawNetwork === undefined ? {} : rawNetwork;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('network', 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!NETWORK_FIELDS.includes(key)) {
      fail('network', `unknown field "${key}"`);
    }
  }

  const network = {
    httpProxyEnv: normalizeOptionalString(value, 'httpProxyEnv', 'network.httpProxyEnv'),
    httpsProxyEnv: normalizeOptionalString(value, 'httpsProxyEnv', 'network.httpsProxyEnv'),
    allProxyEnv: normalizeOptionalString(value, 'allProxyEnv', 'network.allProxyEnv'),
    noProxyEnv: normalizeOptionalString(value, 'noProxyEnv', 'network.noProxyEnv'),
    caFile: normalizeOptionalPath(value, 'caFile', configDir, 'network.caFile'),
    npmRegistry: null,
  };

  if ('npmRegistry' in value && value.npmRegistry !== null && value.npmRegistry !== undefined) {
    network.npmRegistry = validateNpmRegistry(value.npmRegistry);
  }

  return network;
}

export function validateConfig(raw, configDir) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config: raw configuration must be an object');
  }
  if (typeof configDir !== 'string' || configDir === '') {
    throw new Error('config: configDir must be a non-empty string');
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.includes(key)) {
      throw new Error(`config: unknown field "${key}"`);
    }
  }

  const piPath = requireAbsolutePath(raw, 'piPath');
  const stateDir = requireAbsolutePath(raw, 'stateDir');
  const allowedRoots = requireAllowedRoots(raw);

  const piArgs = normalizeStringArray(raw, 'piArgs', []);
  const allowedCommands = normalizeStringArray(raw, 'allowedCommands', []);
  const envAllowlist = normalizeEnvAllowlist(raw);

  const maxConcurrent = normalizeIntRange(raw, 'maxConcurrent', 2, 1, 8);
  const defaultMaxTurns = normalizeIntRange(raw, 'defaultMaxTurns', 30, 1, 100);
  const defaultTimeoutSeconds = normalizePositiveInt(raw, 'defaultTimeoutSeconds', 1800);
  const maxTimeoutSeconds = normalizePositiveInt(raw, 'maxTimeoutSeconds', 7200);
  if (defaultTimeoutSeconds > maxTimeoutSeconds) {
    throw new Error('config: defaultTimeoutSeconds must not exceed maxTimeoutSeconds');
  }

  const provider = normalizeOptionalString(raw, 'provider');
  const model = normalizeOptionalString(raw, 'model');
  const thinkingLevel = normalizeOptionalString(raw, 'thinkingLevel');
  if (provider !== null && model === null) {
    throw new Error('config: model is required when provider is set');
  }

  const agentDir = normalizeOptionalPath(raw, 'agentDir', configDir);
  const modelsFile = normalizeOptionalPath(raw, 'modelsFile', configDir);
  const authFile = normalizeOptionalPath(raw, 'authFile', configDir);

  const network = normalizeNetwork(raw.network, configDir);
  const { queue, verification, budgets, retention, artifacts, offlineMaterials, approvedMcp, context, observation, providerRecovery } = validateCompletionSections(raw, configDir);

  return {
    piPath,
    piArgs,
    stateDir,
    allowedRoots,
    maxConcurrent,
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
    defaultMaxTurns,
    provider,
    model,
    thinkingLevel,
    agentDir,
    modelsFile,
    authFile,
    allowedCommands,
    envAllowlist,
    network,
    queue, verification, budgets, retention, artifacts, offlineMaterials, approvedMcp, context, observation, providerRecovery,
  };
}

const BASE_ENV_KEYS = ['HOME', 'SSH_AUTH_SOCK', 'LANG', 'LC_ALL'];
const CONSERVATIVE_PATH = '/usr/bin:/bin';

const PROXY_PAIRS = {
  httpProxyEnv: ['HTTP_PROXY', 'http_proxy'],
  httpsProxyEnv: ['HTTPS_PROXY', 'https_proxy'],
  allProxyEnv: ['ALL_PROXY', 'all_proxy'],
  noProxyEnv: ['NO_PROXY', 'no_proxy'],
};
const STANDARD_PROXY_KEYS = Object.values(PROXY_PAIRS).flat();

export function buildChildEnv(config, source = process.env) {
  const env = {};

  for (const key of BASE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.PATH = source.PATH !== undefined ? source.PATH : CONSERVATIVE_PATH;

  for (const key of STANDARD_PROXY_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }

  for (const [field, [upperKey, lowerKey]] of Object.entries(PROXY_PAIRS)) {
    const varName = config.network[field];
    if (varName === null) continue;
    const value = source[varName];
    if (value === undefined) {
      throw new Error(`buildChildEnv: environment variable "${varName}" referenced by network.${field} is not set`);
    }
    env[upperKey] = value;
    env[lowerKey] = value;
  }

  if (config.network.caFile !== null) {
    env.NODE_EXTRA_CA_CERTS = config.network.caFile;
    env.GIT_SSL_CAINFO = config.network.caFile;
    env.npm_config_cafile = config.network.caFile;
  }

  if (config.network.npmRegistry !== null) {
    env.npm_config_registry = config.network.npmRegistry;
  }

  for (const name of config.envAllowlist) {
    if (source[name] !== undefined) env[name] = source[name];
  }

  return env;
}

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/=]+/gi;
const USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@]+)@/g;
const MIN_SECRET_LENGTH = 6;

function getKnownSecretValues(sourceEnv) {
  const values = new Set();
  if (!sourceEnv || typeof sourceEnv !== 'object') return values;
  for (const [key, raw] of Object.entries(sourceEnv)) {
    if (typeof raw !== 'string' || raw.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_KEY_PATTERN.test(key)) {
      values.add(raw);
    }
    try {
      const url = new URL(raw);
      if (url.password) values.add(decodeURIComponent(url.password));
      if (url.username) values.add(decodeURIComponent(url.username));
    } catch {
      // Not URL-shaped; nothing more to extract.
    }
  }
  return values;
}

function redactString(value, knownSecrets) {
  let result = value;
  for (const secret of knownSecrets) {
    if (secret && result.includes(secret)) {
      result = result.split(secret).join(REDACTED);
    }
  }
  result = result.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  result = result.replace(USERINFO_PATTERN, `$1${REDACTED}@`);
  return result;
}

function redactValue(value, knownSecrets) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, knownSecrets),
      stack: typeof value.stack === 'string' ? redactString(value.stack, knownSecrets) : value.stack,
    };
  }
  if (typeof value === 'string') {
    return redactString(value, knownSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, knownSecrets));
  }
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(entry, knownSecrets);
    }
    return result;
  }
  return value;
}

export function redact(value, sourceEnv = process.env) {
  return redactValue(value, getKnownSecretValues(sourceEnv));
}

function safeExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

export function healthConfig(config, source = process.env) {
  const agentDirConfigured = config.agentDir !== null;
  const modelsFileConfigured = config.modelsFile !== null;
  const authFileConfigured = config.authFile !== null;

  const network = {};
  for (const field of Object.keys(PROXY_PAIRS)) {
    const varName = config.network[field];
    network[`${field}Configured`] = varName !== null;
    network[`${field}Present`] = varName !== null && source[varName] !== undefined;
  }
  network.caFileConfigured = config.network.caFile !== null;
  network.caFileExists = config.network.caFile !== null && safeExists(config.network.caFile);
  network.npmRegistry = config.network.npmRegistry !== null ? redact(config.network.npmRegistry, source) : null;

  return {
    piPathExists: safeExists(config.piPath),
    stateDirExists: safeExists(config.stateDir),
    allowedRoots: config.allowedRoots.map((root) => ({ path: root, exists: safeExists(root) })),
    agentDirConfigured,
    agentDirExists: agentDirConfigured && safeExists(config.agentDir),
    modelsFileConfigured,
    modelsFileExists: modelsFileConfigured && safeExists(config.modelsFile),
    authFileConfigured,
    authFileExists: authFileConfigured && safeExists(config.authFile),
    provider: config.provider,
    model: config.model,
    allowedCommandsCount: config.allowedCommands.length,
    envAllowlist: config.envAllowlist.map((name) => ({ name, present: source[name] !== undefined })),
    network,
  };
}

export async function loadConfig(file = process.env.PI_MCP_CONFIG) {
  if (typeof file !== 'string' || file === '') {
    throw new Error('loadConfig: no config file path provided (pass a path or set PI_MCP_CONFIG)');
  }
  const resolved = path.resolve(file);

  let raw;
  try {
    const contents = await fsp.readFile(resolved, 'utf8');
    raw = JSON.parse(contents);
  } catch (err) {
    throw new Error(`loadConfig: failed to read or parse "${resolved}" (${err.code || err.name || 'error'})`);
  }

  const config = validateConfig(raw, path.dirname(resolved));
  Object.defineProperty(config, 'configFile', { value: resolved, enumerable: false });
  return config;
}
