import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  validateConfig,
  buildChildEnv,
  redact,
  healthConfig,
} from '../src/config.mjs';

// --- helpers ---------------------------------------------------------

async function makeTempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function minimalRaw(dir) {
  return {
    piPath: path.join(dir, 'pi'),
    stateDir: path.join(dir, 'state'),
    allowedRoots: [path.join(dir, 'roots', 'a')],
  };
}

// =======================================================================
// validateConfig
// =======================================================================

describe('validateConfig: required fields and defaults', () => {
  test('accepts a minimal valid config and fills in documented defaults', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    const raw = minimalRaw(dir);
    const config = validateConfig(raw, dir);

    assert.equal(config.piPath, raw.piPath);
    assert.equal(config.stateDir, raw.stateDir);
    assert.deepEqual(config.allowedRoots, raw.allowedRoots);

    assert.deepEqual(config.piArgs, []);
    assert.equal(config.maxConcurrent, 2);
    assert.equal(config.defaultTimeoutSeconds, 1800);
    assert.equal(config.maxTimeoutSeconds, 7200);
    assert.equal(config.defaultMaxTurns, 30);
    assert.equal(config.provider, null);
    assert.equal(config.model, null);
    assert.equal(config.thinkingLevel, null);
    assert.equal(config.agentDir, null);
    assert.equal(config.modelsFile, null);
    assert.equal(config.authFile, null);
    assert.deepEqual(config.allowedCommands, []);
    assert.deepEqual(config.envAllowlist, []);

    assert.deepEqual(config.network, {
      httpProxyEnv: null,
      httpsProxyEnv: null,
      allProxyEnv: null,
      noProxyEnv: null,
      caFile: null,
      npmRegistry: null,
    });
  });

  test('returns a plain object (not the input reference)', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    const raw = minimalRaw(dir);
    const config = validateConfig(raw, dir);

    assert.notEqual(config, raw);
    assert.equal(Object.getPrototypeOf(config), Object.prototype);
  });

  for (const field of ['piPath', 'stateDir', 'allowedRoots']) {
    test(`rejects missing required field: ${field}`, async (t) => {
      const dir = await makeTempDir('pi-mcp-config-');
      t.after(() => rm(dir, { recursive: true, force: true }));

      const raw = minimalRaw(dir);
      delete raw[field];

      assert.throws(() => validateConfig(raw, dir), new RegExp(field));
    });
  }
});

describe('validateConfig: path type and absoluteness checks', () => {
  test('rejects non-string piPath', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), piPath: 42 };
    assert.throws(() => validateConfig(raw, dir), /piPath/);
  });

  test('rejects relative piPath', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), piPath: 'relative/pi' };
    assert.throws(() => validateConfig(raw, dir), /piPath/);
  });

  test('rejects relative stateDir', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), stateDir: 'relative/state' };
    assert.throws(() => validateConfig(raw, dir), /stateDir/);
  });

  test('rejects empty allowedRoots array', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), allowedRoots: [] };
    assert.throws(() => validateConfig(raw, dir), /allowedRoots/);
  });

  test('rejects allowedRoots entries that are not absolute paths', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), allowedRoots: ['not/absolute'] };
    assert.throws(() => validateConfig(raw, dir), /allowedRoots/);
  });

  test('rejects allowedRoots entries that are not strings', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), allowedRoots: [123] };
    assert.throws(() => validateConfig(raw, dir), /allowedRoots/);
  });

  test('rejects non-array piArgs', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), piArgs: 'not-an-array' };
    assert.throws(() => validateConfig(raw, dir), /piArgs/);
  });

  test('rejects piArgs with non-string entries', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), piArgs: ['ok', 7] };
    assert.throws(() => validateConfig(raw, dir), /piArgs/);
  });

  test('resolves a relative agentDir against configDir', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), agentDir: 'agent-subdir' };
    const config = validateConfig(raw, dir);
    assert.equal(config.agentDir, path.join(dir, 'agent-subdir'));
  });

  test('keeps an already-absolute agentDir unchanged', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const absolute = path.join(dir, 'agent-subdir');
    const raw = { ...minimalRaw(dir), agentDir: absolute };
    const config = validateConfig(raw, dir);
    assert.equal(config.agentDir, absolute);
  });

  test('resolves relative modelsFile, authFile, and network.caFile against configDir', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = {
      ...minimalRaw(dir),
      modelsFile: 'models.json',
      authFile: 'auth.json',
      network: { caFile: 'corp-ca.pem' },
    };
    const config = validateConfig(raw, dir);
    assert.equal(config.modelsFile, path.join(dir, 'models.json'));
    assert.equal(config.authFile, path.join(dir, 'auth.json'));
    assert.equal(config.network.caFile, path.join(dir, 'corp-ca.pem'));
  });
});

describe('validateConfig: numeric ranges', () => {
  test('rejects maxConcurrent below the minimum', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), maxConcurrent: 0 };
    assert.throws(() => validateConfig(raw, dir), /maxConcurrent/);
  });

  test('rejects maxConcurrent above the maximum', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), maxConcurrent: 9 };
    assert.throws(() => validateConfig(raw, dir), /maxConcurrent/);
  });

  test('rejects non-integer maxConcurrent', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), maxConcurrent: 2.5 };
    assert.throws(() => validateConfig(raw, dir), /maxConcurrent/);
  });

  test('accepts maxConcurrent at the documented bounds (1 and 8)', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    assert.equal(validateConfig({ ...minimalRaw(dir), maxConcurrent: 1 }, dir).maxConcurrent, 1);
    assert.equal(validateConfig({ ...minimalRaw(dir), maxConcurrent: 8 }, dir).maxConcurrent, 8);
  });

  test('rejects defaultMaxTurns outside 1..100', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    assert.throws(() => validateConfig({ ...minimalRaw(dir), defaultMaxTurns: 0 }, dir), /defaultMaxTurns/);
    assert.throws(() => validateConfig({ ...minimalRaw(dir), defaultMaxTurns: 101 }, dir), /defaultMaxTurns/);
  });

  test('rejects a non-positive defaultTimeoutSeconds', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    assert.throws(
      () => validateConfig({ ...minimalRaw(dir), defaultTimeoutSeconds: 0 }, dir),
      /defaultTimeoutSeconds/,
    );
  });

  test('rejects defaultTimeoutSeconds greater than maxTimeoutSeconds', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), defaultTimeoutSeconds: 500, maxTimeoutSeconds: 100 };
    assert.throws(() => validateConfig(raw, dir), /defaultTimeoutSeconds|maxTimeoutSeconds/);
  });
});

describe('validateConfig: unknown and risky fields fail closed', () => {
  test('requires model with provider and excludes inline registry credentials', () => {
    const raw = minimalRaw('/tmp/pi-mcp-config-contract');
    assert.throws(() => validateConfig({ ...raw, provider: 'corporate' }, '/tmp'), /model/i);
    assert.throws(() => validateConfig({ ...raw, network: { npmRegistry: 'https://user:secret@registry.example/' } }, '/tmp'), /npmRegistry|credential/i);
  });
  test('rejects an unknown top-level field', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), totallyUnknownField: true };
    assert.throws(() => validateConfig(raw, dir), /totallyUnknownField|unknown/i);
  });

  test('rejects an unknown network field', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), network: { insecure: true } };
    assert.throws(() => validateConfig(raw, dir), /insecure|unknown/i);
  });

  test('rejects network.npmRegistry with a non-http(s) scheme', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), network: { npmRegistry: 'ftp://registry.example.com' } };
    assert.throws(() => validateConfig(raw, dir), /npmRegistry/);
  });

  test('rejects network.npmRegistry that is not a valid URL', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), network: { npmRegistry: 'not a url' } };
    assert.throws(() => validateConfig(raw, dir), /npmRegistry/);
  });

  test('rejects non-string network proxy-env name fields', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), network: { httpProxyEnv: 123 } };
    assert.throws(() => validateConfig(raw, dir), /httpProxyEnv/);
  });

  const dangerousEnvNames = [
    'PATH',
    'HOME',
    'SSH_AUTH_SOCK',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'GIT_SSL_CAINFO',
    'GIT_SSL_NO_VERIFY',
    'npm_config_cafile',
    'npm_config_registry',
    'npm_config_strict_ssl',
    'HTTP_PROXY',
    'http_proxy',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
  ];

  for (const name of dangerousEnvNames) {
    test(`rejects envAllowlist entry for reserved/dangerous name: ${name}`, async (t) => {
      const dir = await makeTempDir('pi-mcp-config-');
      t.after(() => rm(dir, { recursive: true, force: true }));
      const raw = { ...minimalRaw(dir), envAllowlist: [name] };
      assert.throws(() => validateConfig(raw, dir), /envAllowlist|reserved|dangerous/i);
    });
  }

  test('accepts ordinary provider credential names in envAllowlist', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), envAllowlist: ['ANTHROPIC_API_KEY', 'CUSTOM_GATEWAY_TOKEN'] };
    const config = validateConfig(raw, dir);
    assert.deepEqual(config.envAllowlist, ['ANTHROPIC_API_KEY', 'CUSTOM_GATEWAY_TOKEN']);
  });

  test('rejects non-string entries in allowedCommands', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = { ...minimalRaw(dir), allowedCommands: [1, 2] };
    assert.throws(() => validateConfig(raw, dir), /allowedCommands/);
  });

  test('rejects non-string provider/model/thinkingLevel', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    assert.throws(() => validateConfig({ ...minimalRaw(dir), provider: 1 }, dir), /provider/);
    assert.throws(() => validateConfig({ ...minimalRaw(dir), model: 1 }, dir), /model/);
    assert.throws(() => validateConfig({ ...minimalRaw(dir), thinkingLevel: 1 }, dir), /thinkingLevel/);
  });
});

describe('validateConfig: network proxy env naming', () => {
  test('accepts and preserves custom proxy env variable names', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const raw = {
      ...minimalRaw(dir),
      network: {
        httpProxyEnv: 'CORP_HTTP_PROXY',
        httpsProxyEnv: 'CORP_HTTPS_PROXY',
        allProxyEnv: 'CORP_ALL_PROXY',
        noProxyEnv: 'CORP_NO_PROXY',
      },
    };
    const config = validateConfig(raw, dir);
    assert.equal(config.network.httpProxyEnv, 'CORP_HTTP_PROXY');
    assert.equal(config.network.httpsProxyEnv, 'CORP_HTTPS_PROXY');
    assert.equal(config.network.allProxyEnv, 'CORP_ALL_PROXY');
    assert.equal(config.network.noProxyEnv, 'CORP_NO_PROXY');
  });
});

// =======================================================================
// buildChildEnv
// =======================================================================

describe('buildChildEnv: conservative baseline passthrough', () => {
  test('keeps SSH_AUTH_SOCK, HOME, locale and PATH for git credential helpers', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    const source = {
      HOME: '/home/corp-user',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    };
    const env = buildChildEnv(config, source);
    assert.equal(env.HOME, source.HOME);
    assert.equal(env.SSH_AUTH_SOCK, source.SSH_AUTH_SOCK);
    assert.equal(env.PATH, source.PATH);
    assert.equal(env.LANG, source.LANG);
    assert.equal(env.LC_ALL, source.LC_ALL);
  });

  test('never leaks unrelated source variables into the child env', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    const source = { HOME: '/home/u', RANDOM_UNRELATED_SECRET: 'should-not-appear' };
    const env = buildChildEnv(config, source);
    assert.equal(env.RANDOM_UNRELATED_SECRET, undefined);
  });

  test('never passes through dangerous vars even when present in source', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    const source = {
      HOME: '/home/u',
      NODE_OPTIONS: '--require /tmp/evil.js',
      LD_PRELOAD: '/tmp/evil.so',
    };
    const env = buildChildEnv(config, source);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.LD_PRELOAD, undefined);
  });

  test('does not mutate the provided source object', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    const source = { HOME: '/home/u', HTTP_PROXY: 'http://proxy:8080' };
    const snapshot = { ...source };
    buildChildEnv(config, source);
    assert.deepEqual(source, snapshot);
  });
});

describe('buildChildEnv: standard proxy env inheritance', () => {
  test('automatically inherits standard upper-case proxy vars', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    const source = {
      HTTP_PROXY: 'http://proxy.example:8080',
      HTTPS_PROXY: 'http://proxy.example:8443',
      ALL_PROXY: 'http://proxy.example:1080',
      NO_PROXY: 'localhost,127.0.0.1',
    };
    const env = buildChildEnv(config, source);
    assert.equal(env.HTTP_PROXY, source.HTTP_PROXY);
    assert.equal(env.HTTPS_PROXY, source.HTTPS_PROXY);
    assert.equal(env.ALL_PROXY, source.ALL_PROXY);
    assert.equal(env.NO_PROXY, source.NO_PROXY);
  });

  test('automatically inherits standard lower-case proxy vars', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    const source = {
      http_proxy: 'http://proxy.example:8080',
      https_proxy: 'http://proxy.example:8443',
      all_proxy: 'http://proxy.example:1080',
      no_proxy: 'localhost,127.0.0.1',
    };
    const env = buildChildEnv(config, source);
    assert.equal(env.http_proxy, source.http_proxy);
    assert.equal(env.https_proxy, source.https_proxy);
    assert.equal(env.all_proxy, source.all_proxy);
    assert.equal(env.no_proxy, source.no_proxy);
  });

  test('does not fabricate proxy vars that are absent from source', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    const env = buildChildEnv(config, { HOME: '/home/u' });
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
      assert.equal(env[key], undefined);
    }
  });
});

describe('buildChildEnv: named corporate proxy env fields', () => {
  test('maps a custom httpProxyEnv variable onto HTTP_PROXY/http_proxy', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig({ ...minimalRaw(dir), network: { httpProxyEnv: 'CORP_HTTP_PROXY' } }, dir);
    const env = buildChildEnv(config, { CORP_HTTP_PROXY: 'http://corp-proxy:8080' });
    assert.equal(env.HTTP_PROXY, 'http://corp-proxy:8080');
    assert.equal(env.http_proxy, 'http://corp-proxy:8080');
  });

  test('maps httpsProxyEnv, allProxyEnv, and noProxyEnv similarly', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(
      {
        ...minimalRaw(dir),
        network: {
          httpsProxyEnv: 'CORP_HTTPS_PROXY',
          allProxyEnv: 'CORP_ALL_PROXY',
          noProxyEnv: 'CORP_NO_PROXY',
        },
      },
      dir,
    );
    const env = buildChildEnv(config, {
      CORP_HTTPS_PROXY: 'http://corp-proxy:8443',
      CORP_ALL_PROXY: 'http://corp-proxy:1080',
      CORP_NO_PROXY: '.corp.internal',
    });
    assert.equal(env.HTTPS_PROXY, 'http://corp-proxy:8443');
    assert.equal(env.https_proxy, 'http://corp-proxy:8443');
    assert.equal(env.ALL_PROXY, 'http://corp-proxy:1080');
    assert.equal(env.all_proxy, 'http://corp-proxy:1080');
    assert.equal(env.NO_PROXY, '.corp.internal');
    assert.equal(env.no_proxy, '.corp.internal');
  });

  test('throws when the named proxy env variable is required but missing from source', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig({ ...minimalRaw(dir), network: { httpProxyEnv: 'CORP_HTTP_PROXY' } }, dir);
    assert.throws(() => buildChildEnv(config, { HOME: '/home/u' }), /CORP_HTTP_PROXY/);
  });

  test('a configured named proxy env overrides a conflicting standard proxy var', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig({ ...minimalRaw(dir), network: { httpProxyEnv: 'CORP_HTTP_PROXY' } }, dir);
    const env = buildChildEnv(config, {
      HTTP_PROXY: 'http://stale-proxy:9999',
      CORP_HTTP_PROXY: 'http://corp-proxy:8080',
    });
    assert.equal(env.HTTP_PROXY, 'http://corp-proxy:8080');
  });
});

describe('buildChildEnv: CA and registry propagation', () => {
  test('propagates network.caFile to NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, and npm_config_cafile', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const caFile = path.join(dir, 'corp-ca.pem');
    const config = validateConfig({ ...minimalRaw(dir), network: { caFile } }, dir);
    const env = buildChildEnv(config, {});
    assert.equal(env.NODE_EXTRA_CA_CERTS, caFile);
    assert.equal(env.GIT_SSL_CAINFO, caFile);
    assert.equal(env.npm_config_cafile, caFile);
  });

  test('propagates network.npmRegistry to npm_config_registry', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(
      { ...minimalRaw(dir), network: { npmRegistry: 'https://npm.corp.internal/' } },
      dir,
    );
    const env = buildChildEnv(config, {});
    assert.equal(env.npm_config_registry, 'https://npm.corp.internal/');
  });

  test('never disables TLS verification regardless of config', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    const env = buildChildEnv(config, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assert.notEqual(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
    assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  });
});

describe('buildChildEnv: envAllowlist passthrough', () => {
  test('passes through allowlisted provider/gateway credentials present in source', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig({ ...minimalRaw(dir), envAllowlist: ['ANTHROPIC_API_KEY'] }, dir);
    const env = buildChildEnv(config, { ANTHROPIC_API_KEY: 'sk-ant-abc123' });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-abc123');
  });

  test('omits allowlisted names that are absent from source rather than injecting empty values', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig({ ...minimalRaw(dir), envAllowlist: ['ANTHROPIC_API_KEY'] }, dir);
    const env = buildChildEnv(config, {});
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY'));
  });

  test('does not pass through credentials that are not in the allowlist', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    const env = buildChildEnv(config, { ANTHROPIC_API_KEY: 'sk-ant-abc123' });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });
});

// =======================================================================
// redact
// =======================================================================

describe('redact: credential-like keys', () => {
  const secretKeyNames = ['apiKey', 'api_key', 'password', 'token', 'secret', 'Authorization', 'authToken', 'privateKey'];

  for (const key of secretKeyNames) {
    test(`masks the value under credential-like key: ${key}`, () => {
      const input = { [key]: 'super-secret-value', other: 'keep-me' };
      const output = redact(input, {});
      assert.equal(output[key], '[REDACTED]');
      assert.equal(output.other, 'keep-me');
    });
  }

  test('masks credential-like keys recursively nested in objects and arrays', () => {
    const input = { nested: { list: [{ token: 'abc' }, { safe: 'value' }] } };
    const output = redact(input, {});
    assert.equal(output.nested.list[0].token, '[REDACTED]');
    assert.equal(output.nested.list[1].safe, 'value');
  });

  test('does not mutate the original input', () => {
    const input = { password: 'abc' };
    const clone = JSON.parse(JSON.stringify(input));
    redact(input, {});
    assert.deepEqual(input, clone);
  });

  test('passes through primitives, null, and undefined unchanged', () => {
    assert.equal(redact(42, {}), 42);
    assert.equal(redact(true, {}), true);
    assert.equal(redact(null, {}), null);
    assert.equal(redact(undefined, {}), undefined);
  });
});

describe('redact: string content scanning', () => {
  test('masks Bearer tokens embedded in strings', () => {
    const input = 'calling API with Authorization: Bearer abc123.def456-ghi';
    const output = redact(input, {});
    assert.ok(!output.includes('abc123.def456-ghi'));
    assert.match(output, /Bearer \[REDACTED\]/);
  });

  test('masks URL userinfo credentials', () => {
    const input = 'fetching https://corpuser:corppass@git.internal/repo.git';
    const output = redact(input, {});
    assert.ok(!output.includes('corpuser:corppass'));
    assert.match(output, /https:\/\/\[REDACTED\]@git\.internal\/repo\.git/);
  });

  test('masks known credential env values found verbatim in strings', () => {
    const sourceEnv = { ANTHROPIC_API_KEY: 'sk-ant-superSecretValue123' };
    const input = `request failed using key sk-ant-superSecretValue123 against upstream`;
    const output = redact(input, sourceEnv);
    assert.ok(!output.includes('sk-ant-superSecretValue123'));
    assert.match(output, /\[REDACTED\]/);
  });

  test('leaves ordinary strings without secrets unchanged', () => {
    const input = 'plain diagnostic message with no secrets';
    assert.equal(redact(input, { ANTHROPIC_API_KEY: 'sk-ant-superSecretValue123' }), input);
  });
});

describe('redact: Error instances', () => {
  test('masks secret values embedded in an Error message', () => {
    const sourceEnv = { ANTHROPIC_API_KEY: 'sk-ant-superSecretValue123' };
    const error = new Error('auth failed for key sk-ant-superSecretValue123');
    const output = redact(error, sourceEnv);
    assert.ok(!JSON.stringify(output).includes('sk-ant-superSecretValue123'));
    assert.match(output.message, /\[REDACTED\]/);
  });

  test('returns a plain object with name, message, and stack for Error input', () => {
    const error = new Error('boom');
    const output = redact(error, {});
    assert.equal(output.name, 'Error');
    assert.equal(typeof output.message, 'string');
    assert.equal(typeof output.stack, 'string');
    assert.ok(!(output instanceof Error));
  });
});

// =======================================================================
// healthConfig
// =======================================================================

describe('healthConfig', () => {
  test('reports booleans for configured paths without leaking secret values', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    const piPath = path.join(dir, 'pi');
    await writeFile(piPath, '#!/bin/sh\n');

    const config = validateConfig(
      { ...minimalRaw(dir), piPath, envAllowlist: ['ANTHROPIC_API_KEY'] },
      dir,
    );
    const source = { ANTHROPIC_API_KEY: 'sk-ant-superSecretValue123' };
    const health = healthConfig(config, source);

    assert.equal(typeof health.piPathExists, 'boolean');
    assert.equal(health.piPathExists, true);
    assert.equal(typeof health.stateDirExists, 'boolean');

    const serialized = JSON.stringify(health);
    assert.ok(!serialized.includes('sk-ant-superSecretValue123'));
  });

  test('reports envAllowlist presence as booleans only, never values', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig({ ...minimalRaw(dir), envAllowlist: ['ANTHROPIC_API_KEY', 'MISSING_TOKEN'] }, dir);
    const health = healthConfig(config, { ANTHROPIC_API_KEY: 'sk-ant-xyz' });

    const entries = Object.fromEntries(health.envAllowlist.map((e) => [e.name, e.present]));
    assert.equal(entries.ANTHROPIC_API_KEY, true);
    assert.equal(entries.MISSING_TOKEN, false);
    assert.ok(!JSON.stringify(health).includes('sk-ant-xyz'));
  });

  test('reports named proxy env configuration and presence without throwing on missing values', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig({ ...minimalRaw(dir), network: { httpProxyEnv: 'CORP_HTTP_PROXY' } }, dir);
    const health = healthConfig(config, {});
    assert.equal(health.network.httpProxyEnvConfigured, true);
    assert.equal(health.network.httpProxyEnvPresent, false);
  });

  test('does not include actual proxy or CA file secret contents', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = validateConfig(minimalRaw(dir), dir);
    config.network.npmRegistry = 'https://user:regsecret@npm.corp.internal/';
    const health = healthConfig(config, {});
    assert.ok(!JSON.stringify(health).includes('regsecret'));
  });
});

// =======================================================================
// loadConfig
// =======================================================================

describe('loadConfig', () => {
  test('reads JSON from disk and validates it, resolving relative paths against the file directory', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, 'pi-mcp.config.json');
    const raw = { ...minimalRaw(dir), agentDir: 'agent-subdir' };
    await writeFile(file, JSON.stringify(raw));

    const config = await loadConfig(file);
    assert.equal(config.piPath, raw.piPath);
    assert.equal(config.agentDir, path.join(dir, 'agent-subdir'));
  });

  test('rejects a missing config file', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'does-not-exist.json');
    await assert.rejects(() => loadConfig(file));
  });

  test('rejects invalid JSON content', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'broken.json');
    await writeFile(file, '{ not valid json');
    await assert.rejects(() => loadConfig(file));
  });

  test('propagates validation errors for an invalid config file', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'invalid.json');
    await writeFile(file, JSON.stringify({ piPath: 'relative/pi' }));
    await assert.rejects(() => loadConfig(file), /piPath|stateDir|allowedRoots/);
  });

  test('uses process.env.PI_MCP_CONFIG when no argument is given', async (t) => {
    const dir = await makeTempDir('pi-mcp-config-');
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, 'pi-mcp.config.json');
    const raw = minimalRaw(dir);
    await writeFile(file, JSON.stringify(raw));

    const previous = process.env.PI_MCP_CONFIG;
    process.env.PI_MCP_CONFIG = file;
    t.after(() => {
      if (previous === undefined) delete process.env.PI_MCP_CONFIG;
      else process.env.PI_MCP_CONFIG = previous;
    });

    const config = await loadConfig();
    assert.equal(config.piPath, raw.piPath);
  });

  test('rejects when no file argument and no PI_MCP_CONFIG env var are set', async (t) => {
    const previous = process.env.PI_MCP_CONFIG;
    delete process.env.PI_MCP_CONFIG;
    t.after(() => {
      if (previous !== undefined) process.env.PI_MCP_CONFIG = previous;
    });

    await assert.rejects(() => loadConfig());
  });
});
