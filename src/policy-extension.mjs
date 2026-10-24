import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Type } from '@sinclair/typebox';
import { authorizeTool } from './policy.mjs';
import { registerApprovedMcp } from './approved-mcp.mjs';
import { normalizeContext, reduceContext, guardProviderPayload } from './context-policy.mjs';
import { createObservation, normalizeObservation } from './observation.mjs';

export default function policyExtension(pi) {
  const configFile = process.env.PI_MCP_POLICY;
  if (!configFile) throw new Error('PI_MCP_POLICY is required');
  let policy;
  let observer;
  let contextPolicy;
  let observationPolicy;
  let attemptId = randomUUID();
  let requestId = randomUUID();
  let pendingRetry = null;
  const toolIds = new Map();
  let configuredToolNames = new Set();
  const ready = fs.readFile(configFile, 'utf8').then(text => {
    policy = JSON.parse(text);
    contextPolicy = normalizeContext(policy.context);
    observationPolicy = normalizeObservation(policy.observation);
    observer = createObservation({ policy: observationPolicy, jobId: policy.jobId,
      observationFile: policy.observationFile, activityFile: policy.activityFile, stopFile: policy.stopFile });
    return policy;
  });
  const stop = async (reason, ctx) => { await observer.stop(reason); ctx.abort(); };
  const denial = async (toolName, reason) => {
    await ready;
    await fs.appendFile(policy.denyFile, JSON.stringify({ time: new Date().toISOString(), toolName, reason }) + '\n', { mode: 0o600 });
  };
  let approvedSession = null;
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
    if (approvedSession) await approvedSession.close();
    approvedSession = await registerApprovedMcp(pi, policy);
    const tools = [...(policy.mode === 'review' ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'write', 'edit', 'safe_shell']), ...approvedSession.toolNames];
    pi.setActiveTools(tools);
    const active = pi.getActiveTools();
    if (active.length !== tools.length || active.some(name => !tools.includes(name))) throw new Error('Policy tools not active');
    configuredToolNames = new Set(active);
    await fs.writeFile(policy.readyFile, JSON.stringify({ nonce: policy.nonce, pid: process.pid, tools: active }) + '\n', { mode: 0o600 });
    await observer.record('agent_start');
  });
  pi.on('context_with_system', async (event, ctx) => {
    await ready;
    const result = reduceContext(event.messages, contextPolicy);
    if (!result.ok) { await stop('context_limit', ctx); return; }
    if (result.droppedMessages) await observer.record('context_reduction', { droppedMessages: result.droppedMessages });
    return { messages: result.messages };
  });
  pi.on('before_provider_request', async (event, ctx) => {
    await ready;
    if (!pendingRetry) requestId = randomUUID();
    const result = guardProviderPayload(event.payload, contextPolicy);
    if (!result.ok) { await stop('context_limit', ctx); return event.payload; }
    if (result.droppedMessages) await observer.record('context_reduction', { droppedMessages: result.droppedMessages });
    return result.payload;
  });
  pi.on('before_provider_headers', async event => {
    await ready;
    attemptId = randomUUID();
    if (policy.traceInternalGateway === true && typeof policy.jobId === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(policy.jobId)) {
      event.headers['x-pi-job-id'] = policy.jobId;
      event.headers['x-pi-request-id'] = requestId;
      event.headers['x-pi-attempt-id'] = attemptId;
    }
    if (pendingRetry) { await observer.record('provider_retry', { requestId, attemptId, retryReason: pendingRetry }); pendingRetry = null; }
    await observer.record('provider_request', { requestId, attemptId });
  });
  pi.on('after_provider_response', async event => {
    await ready;
    const category = event.status === 429 ? 'rate_limit' : event.status >= 500 ? 'upstream' : event.status >= 400 ? 'protocol' : 'ok';
    await observer.record('provider_response', { attemptId, category, isError: event.status >= 400 });
    pendingRetry = event.status === 429 || event.status >= 500 ? category : null;
  });
  pi.on('tool_execution_start', async event => {
    await ready;
    const toolId = randomUUID();
    toolIds.set(event.toolCallId, { toolId, startedAt: performance.now() });
    await observer.record('tool_start', { toolId, toolName: configuredToolNames.has(event.toolName) ? event.toolName : undefined });
  });
  pi.on('tool_execution_end', async (event, ctx) => {
    await ready;
    const local = toolIds.get(event.toolCallId);
    toolIds.delete(event.toolCallId);
    await observer.record('tool_end', { toolId: local?.toolId, toolName: configuredToolNames.has(event.toolName) ? event.toolName : undefined,
      isError: event.isError === true, durationMs: event.durationMs ?? (local ? performance.now() - local.startedAt : undefined) });
    const limit = observationPolicy.consecutiveFailureLimit;
    if (limit > 0 && observer.snapshot().consecutiveToolFailures >= limit) ctx.abort();
  });
  pi.on('session_before_compact', async event => { await ready; await observer.record('compaction', { outcome: 'started' }); });
  pi.on('session_compact', async () => { await ready; await observer.record('compaction', { outcome: 'completed' }); });
  pi.on('session_compact_failed', async () => { await ready; await observer.record('compaction', { outcome: 'failed' }); });
  pi.on('agent_settled', async () => { await ready; pendingRetry = null; await observer.record('agent_end'); });
  pi.on('session_shutdown', async () => { if (approvedSession) { await approvedSession.close(); approvedSession = null; } });
}
