import http from 'node:http';
import { loadAndValidateProfile } from './profile.mjs';
import { assertSandbox } from './sandbox.mjs';

function assertEnvironment() {
  if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) throw new Error('internal MCP requires UID/GID 1000');
  const forbidden = /^(?:https?_proxy|all_proxy|no_proxy|node_options|node_extra_ca_certs|git_config_.*|ssh_auth_sock|pi_coding_agent_dir|pi_mcp_policy|pi_mcp_config|npm_config_.*)$/i;
  for (const name of Object.keys(process.env)) if (forbidden.test(name)) throw new Error(`forbidden environment variable ${name}`);
  if (process.env.HOME !== '/var/lib/pi-mcp/home') throw new Error('unexpected HOME');
}

async function gatewayReady() {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:18080/healthz', { timeout: 3000 }, response => {
      response.resume();
      response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('gateway unavailable')));
    });
    request.on('timeout', () => request.destroy(new Error('gateway timeout')));
    request.on('error', () => reject(new Error('gateway unavailable')));
  });
}

try {
  assertEnvironment();
  await assertSandbox();
  await loadAndValidateProfile();
  await gatewayReady();
  process.env.PI_MCP_CONFIG = '/etc/pi-internal/config.json';
  await import('../src/server.mjs');
} catch (error) {
  console.error(`internal MCP startup refused: ${error.message}`);
  process.exitCode = 1;
}
