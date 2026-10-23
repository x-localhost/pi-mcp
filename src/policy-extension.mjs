import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Type } from '@sinclair/typebox';
import { authorizeTool } from './policy.mjs';

export default function policyExtension(pi) {
  const configFile = process.env.PI_MCP_POLICY;
  if (!configFile) throw new Error('PI_MCP_POLICY is required');
  let policy;
  const ready = fs.readFile(configFile, 'utf8').then(text => { policy = JSON.parse(text); return policy; });
  const denial = async (toolName, reason) => {
    await ready;
    await fs.appendFile(policy.denyFile, JSON.stringify({ time: new Date().toISOString(), toolName, reason }) + '\n', { mode: 0o600 });
  };
  pi.registerTool({
    name: 'safe_shell', label: 'Approved command',
    description: 'Run an administrator-approved exact command in this worktree. Commands may execute repository scripts.',
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params, signal) {
      await ready;
      const decision = await authorizeTool(policy, 'safe_shell', params);
      if (!decision.allow) { await denial('safe_shell', decision.reason); return { content: [{ type: 'text', text: `Denied: ${decision.reason}` }], isError: true }; }
      return new Promise(resolve => {
        const child = spawn('/bin/sh', ['-c', params.command], { cwd: policy.worktree, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
        let output = ''; let ended = false;
        const append = chunk => { output = (output + chunk.toString('utf8')).slice(-32000); };
        child.stdout.on('data', append); child.stderr.on('data', append);
        const abort = () => { try { child.kill('SIGTERM'); } catch {} };
        signal?.addEventListener('abort', abort, { once: true });
        child.on('error', error => { if (!ended) { ended = true; resolve({ content: [{ type: 'text', text: `Command failed: ${error.message}` }], isError: true }); } });
        child.on('close', code => { signal?.removeEventListener('abort', abort); if (!ended) { ended = true; resolve({ content: [{ type: 'text', text: output || `Exit ${code}` }], isError: code !== 0 }); } });
      });
    }
  });
  pi.on('tool_call', async event => {
    await ready;
    const decision = await authorizeTool(policy, event.toolName, event.input);
    if (!decision.allow) { await denial(event.toolName, decision.reason); return { block: true, reason: decision.reason }; }
  });
  pi.on('session_start', async (_event, ctx) => {
    await ready;
    if (ctx.cwd !== policy.worktree) throw new Error('Policy cwd mismatch');
    const tools = policy.mode === 'review' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'safe_shell'];
    pi.setActiveTools(tools);
    const active = pi.getActiveTools();
    if (active.length !== tools.length || active.some(name => !tools.includes(name))) throw new Error('Policy tools not active');
    await fs.writeFile(policy.readyFile, JSON.stringify({ nonce: policy.nonce, pid: process.pid, tools: active }) + '\n', { mode: 0o600 });
  });
}
