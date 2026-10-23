import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { assertSandbox } from './sandbox.mjs';
import { loadAndValidateProfile } from './profile.mjs';

const [name, commit] = process.argv.slice(2);
const MAX_BUNDLE = 64 * 1024 * 1024;
if (!/^[a-z][a-z0-9-]{0,47}$/.test(name || '') || !/^[0-9a-f]{40}$/.test(commit || '')) {
  console.error('usage: import-bundle.mjs <lowercase-name> <40-char-commit>');
  process.exit(2);
}

function git(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'init.templateDir=/dev/null', ...args], {
      ...options, env: { HOME: '/var/lib/pi-mcp/home', PATH: '/usr/local/bin:/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 4096) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 4096) child.kill(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git import failed (${code})`)));
  });
}

let temporary;
try {
  await assertSandbox();
  await loadAndValidateProfile();
  const destination = path.join('/workspace', name);
  await fs.access(destination).then(() => { throw new Error('destination already exists'); }, error => { if (error.code !== 'ENOENT') throw error; });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bundle-'));
  const bundle = path.join(temporary, 'source.bundle');
  let bytes = 0;
  await pipeline(process.stdin, new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    done(bytes <= MAX_BUNDLE ? null : new Error('bundle exceeds 64 MiB limit'), chunk);
  } }), createWriteStream(bundle, { flags: 'wx', mode: 0o600 }));
  const heads = (await git(['bundle', 'list-heads', bundle])).split('\n').filter(Boolean);
  if (heads.length !== 1 || !heads[0].startsWith(`${commit} refs/heads/`)) throw new Error('bundle must contain only the selected branch commit');
  const branchRef = heads[0].slice(commit.length + 1);
  await git(['init', '-q', '-b', 'imported', destination]);
  await git(['-C', destination, 'fetch', '--no-tags', '--no-recurse-submodules', bundle, branchRef]);
  await git(['-C', destination, 'checkout', '-q', '--detach', commit]);
  if (await git(['-C', destination, 'rev-parse', 'HEAD']) !== commit) throw new Error('imported commit mismatch');
  console.log(`Imported ${commit} to ${destination}`);
} catch (error) {
  console.error(`bundle import refused: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
}
