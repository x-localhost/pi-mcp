// Test-only request shape capture. Prints field names and types, never prompts or secrets.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Manager } from '/app/src/manager.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-shape-'));
const repo = path.join(tmp, 'repo');
await fs.mkdir(repo);
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
git('init', '-q');
await fs.writeFile(path.join(repo, 'AGENTS.md'), 'Request-shape test.');
git('add', 'AGENTS.md');
git('-c', 'user.name=Mock', '-c', 'user.email=mock@example.invalid', 'commit', '-qm', 'base');

let resolveSeen;
const seen = new Promise(resolve => { resolveSeen = resolve; });
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify({
    keys: Object.keys(body).sort(),
    model: body.model,
    messageShapes: body.messages?.map(message => Object.fromEntries(Object.entries(message).map(([key, value]) => [key, Array.isArray(value) ? `array:${value.length}` : value === null ? 'null' : typeof value]))),
    toolShapes: body.tools?.map(tool => ({ keys: Object.keys(tool).sort(), functionKeys: Object.keys(tool.function || {}).sort() })),
    optionTypes: Object.fromEntries(Object.entries(body).filter(([key]) => !['messages', 'tools', 'model'].includes(key)).map(([key, value]) => [key, typeof value])),
  }));
  res.writeHead(400); res.end(); resolveSeen();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelFile = path.join(tmp, 'models.json');
await fs.writeFile(modelFile, JSON.stringify({ providers: { corporate: {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'placeholder',
  models: [{ id: 'approved-model', name: 'Approved model', contextWindow: 8192, maxTokens: 512 }],
} } }));
const manager = await new Manager({ stateDir: path.join(tmp, 'state'), allowedRoots: [tmp], maxConcurrent: 1, defaultTimeoutSeconds: 15, maxTimeoutSeconds: 30,
  defaultMaxTurns: 2, piPath: process.execPath, piArgs: ['/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'], modelsFile: modelFile,
  provider: 'corporate', model: 'approved-model', allowedCommands: [] }, { PATH: process.env.PATH, HOME: tmp, LANG: 'C.UTF-8' }).init();
await manager.start({ repository: repo, title: 'Capture request shape', prompt: 'Read AGENTS.md.', mode: 'review' });
await Promise.race([seen, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Pi did not request model')), 15000))]);
server.close();
