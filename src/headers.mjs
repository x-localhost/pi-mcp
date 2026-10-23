// Non-executing parser/validator for Pi 1.4.0 models.json provider/model `headers`
// (and the matching auth.json credential `env` overlay), shared by manager.mjs
// (preflight, before any job/worktree allocation) and worker.mjs (revalidation
// before spawning Pi, and secret collection for redaction). See
// docs/corporate-headers-plan.md and docs/corporate-headers-report.md.
//
// Template grammar (matches the installed Pi 1.4.0 parser): "$$" is a literal
// "$", "$!" is a literal "!", "$NAME"/"${NAME}" reference an environment
// variable named with [A-Za-z_][A-Za-z0-9_]*, an invalid or unclosed "${"
// sequence is left as literal text, and a resolved reference's value is never
// re-scanned for further references.

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const IDENT_FULL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function scanTemplate(value) {
  const parts = [];
  let literal = '';
  const flush = () => { if (literal) { parts.push({ type: 'literal', text: literal }); literal = ''; } };
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch !== '$') { literal += ch; i++; continue; }
    const next = value[i + 1];
    if (next === '$') { literal += '$'; i += 2; continue; }
    if (next === '!') { literal += '!'; i += 2; continue; }
    if (next === '{') {
      const close = value.indexOf('}', i + 2);
      const name = close !== -1 ? value.slice(i + 2, close) : null;
      if (name !== null && IDENT_FULL.test(name)) { flush(); parts.push({ type: 'ref', name }); i = close + 1; continue; }
      literal += ch; i++; continue;
    }
    if (next !== undefined && IDENT_START.test(next)) {
      let j = i + 1;
      while (j < value.length && IDENT_CHAR.test(value[j])) j++;
      flush(); parts.push({ type: 'ref', name: value.slice(i + 1, j) }); i = j; continue;
    }
    literal += ch; i++;
  }
  flush();
  return parts;
}

export function referencedNames(value) {
  return scanTemplate(value).filter(part => part.type === 'ref').map(part => part.name);
}

export function isValidHeaderName(name) {
  return typeof name === 'string' && HEADER_NAME_PATTERN.test(name);
}

export function hasForbiddenBytes(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function label(context) { return context ? ` for "${context}"` : ''; }

export function validateHeaderMapSyntax(headersMap, context = '') {
  if (headersMap === undefined) return;
  if (headersMap === null || typeof headersMap !== 'object' || Array.isArray(headersMap)) {
    throw new Error(`Invalid headers configuration${label(context)}`);
  }
  for (const [name, value] of Object.entries(headersMap)) {
    if (!isValidHeaderName(name)) throw new Error(`Invalid header name${label(context)}`);
    if (typeof value !== 'string') throw new Error(`Header "${name}" value must be a string${label(context)}`);
    if (value.startsWith('!')) throw new Error('Command-bearing credential value is unsupported');
    if (hasForbiddenBytes(value)) throw new Error(`Header "${name}" value contains an invalid control character${label(context)}`);
  }
}

export function collectHeaderRefNames(headersMap, names = new Set()) {
  if (!headersMap || typeof headersMap !== 'object') return names;
  for (const value of Object.values(headersMap)) {
    if (typeof value !== 'string') continue;
    for (const name of referencedNames(value)) names.add(name);
  }
  return names;
}

function resolveReference(name, credentialEnv, childEnv) {
  const fromCredential = credentialEnv && typeof credentialEnv[name] === 'string' && credentialEnv[name] !== '' ? credentialEnv[name] : undefined;
  return fromCredential !== undefined ? fromCredential : childEnv[name];
}

export function checkHeaderMapEnv(headersMap, { credentialEnv = {}, childEnv = {} } = {}) {
  if (!headersMap || typeof headersMap !== 'object') return;
  for (const [name, value] of Object.entries(headersMap)) {
    if (typeof value !== 'string') continue;
    for (const refName of referencedNames(value)) {
      const resolved = resolveReference(refName, credentialEnv, childEnv);
      if (typeof resolved !== 'string' || resolved === '') {
        throw new Error(`Header "${name}" references environment variable "${refName}" that is missing or empty in the forwarded environment`);
      }
      if (hasForbiddenBytes(resolved)) {
        throw new Error(`Header "${name}" resolves to a value with an invalid control character`);
      }
    }
  }
}

export function selectAuthCredential(authConfig, providerId) {
  if (!authConfig || typeof authConfig !== 'object') return null;
  const entry = authConfig[providerId];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
}

// Syntax is validated across every provider/model header map (defense in
// depth, no I/O cost); missing/empty environment references are only
// enforced for the selected provider and selected model, so an unused
// provider with an absent credential cannot block an unrelated job. The
// selected provider's own headers are always checked even when a model
// overlay later overwrites the same header name.
export function validateProviderHeaders({ modelsConfig, authConfig, provider, model, childEnv = {} }) {
  const providers = modelsConfig && typeof modelsConfig === 'object' ? modelsConfig.providers : null;
  if (!providers || typeof providers !== 'object') return;
  for (const [providerId, providerEntry] of Object.entries(providers)) {
    if (!providerEntry || typeof providerEntry !== 'object') continue;
    validateHeaderMapSyntax(providerEntry.headers, providerId);
    for (const modelEntry of Array.isArray(providerEntry.models) ? providerEntry.models : []) {
      if (!modelEntry || typeof modelEntry !== 'object') continue;
      validateHeaderMapSyntax(modelEntry.headers, `${providerId}/${modelEntry.id}`);
    }
  }
  const selectedProvider = providers[provider];
  if (!selectedProvider || typeof selectedProvider !== 'object') return;
  const credential = selectAuthCredential(authConfig, provider);
  const credentialEnv = credential && credential.env && typeof credential.env === 'object' ? credential.env : {};
  checkHeaderMapEnv(selectedProvider.headers, { credentialEnv, childEnv });
  const selectedModel = Array.isArray(selectedProvider.models) ? selectedProvider.models.find(entry => entry && entry.id === model) : null;
  if (selectedModel) {
    // OAuth credential env is provider-scoped only; model headers fall back to the forwarded child env.
    const modelCredentialEnv = credential && credential.type === 'oauth' ? {} : credentialEnv;
    checkHeaderMapEnv(selectedModel.headers, { credentialEnv: modelCredentialEnv, childEnv });
  }
}

// Every header-referenced environment name across the whole file, used to
// widen redaction coverage to arbitrary (non-credential-looking) custom
// header names regardless of which provider/model a given job used.
export function allHeaderRefNames(modelsConfig) {
  const names = new Set();
  const providers = modelsConfig && typeof modelsConfig === 'object' ? modelsConfig.providers : null;
  if (!providers || typeof providers !== 'object') return names;
  for (const providerEntry of Object.values(providers)) {
    if (!providerEntry || typeof providerEntry !== 'object') continue;
    collectHeaderRefNames(providerEntry.headers, names);
    for (const modelEntry of Array.isArray(providerEntry.models) ? providerEntry.models : []) collectHeaderRefNames(modelEntry?.headers, names);
  }
  return names;
}
