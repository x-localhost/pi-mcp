import fs from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function mountOptions(mountinfo, target) {
  const row = mountinfo.split('\n').find(line => line.split(' ')[4] === target);
  if (!row) throw new Error(`missing ${target} mount`);
  return row.split(' ')[5].split(',');
}

export async function assertSandbox({ agent = true } = {}) {
  if (process.platform !== 'linux' || process.getuid?.() !== 1000 || process.getgid?.() !== 1000) throw new Error('Linux UID/GID 1000 required');
  const status = await fs.readFile('/proc/self/status', 'utf8');
  if (!/^CapEff:\s*0+$/m.test(status)) throw new Error('effective capabilities must be zero');
  if (!/^NoNewPrivs:\s*1$/m.test(status)) throw new Error('no-new-privileges is required');
  if (!/^Seccomp:\s*2$/m.test(status)) throw new Error('seccomp filter is required');
  const mounts = await fs.readFile('/proc/self/mountinfo', 'utf8');
  if (!mountOptions(mounts, '/').includes('ro')) throw new Error('root filesystem must be read-only');
  for (const target of agent ? ['/etc/pi-internal/config.json', '/etc/pi-internal/models.json', '/run/pi-internal'] : ['/etc/pi-internal/gateway.json', '/etc/pi-internal/ca.pem']) {
    if (!mountOptions(mounts, target).includes('ro')) throw new Error(`${target} must be read-only`);
  }
  if (agent) {
    const probe = spawnSync('python3', ['/app/internal-agent/probe-vsock.py'], { timeout: 3000, stdio: 'ignore' });
    if (probe.status !== 0) throw new Error('AF_VSOCK creation is not denied');
    const interfaces = os.networkInterfaces();
    if (Object.keys(interfaces).some(name => name !== 'lo')) throw new Error('agent has a non-loopback interface');
    for (const target of ['/workspace', '/var/lib/pi-mcp']) {
      if (!mountOptions(mounts, target).includes('rw')) throw new Error(`${target} must be writable private storage`);
    }
  }
}
