import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (!argv.length) process.exit(2);
fs.writeSync(3, 'READY\n');
let input = '';
for await (const chunk of process.stdin) { input += chunk.toString(); if (input.includes('\n')) break; }
if (input !== 'RUN\n') process.exit(2);
const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', error => { process.stderr.write(`Verifier spawn failed: ${error.code || 'error'}\n`); process.exitCode = 127; });
const [code, signal] = await once(child, 'exit');
if (signal) process.kill(process.pid, signal);
else process.exitCode = code ?? 1;
