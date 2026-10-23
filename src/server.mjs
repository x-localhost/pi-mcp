#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, buildChildEnv, healthConfig } from './config.mjs';
import { Manager } from './manager.mjs';
import { sanitize } from './sanitize.mjs';

process.umask(0o077);
const config = await loadConfig();
const childEnv = buildChildEnv(config);
const manager = await new Manager(config, childEnv).init();
const server = new McpServer({ name: 'pi-mcp', version: '0.1.0' }, {
  instructions: 'Start with pi_health. A delegated task runs in a new worktree from a committed ref and consumes the configured Pi provider. Start returns a job ID immediately. Poll pi_status and read pi_result. request_id makes retries idempotent. Followups reuse the same worktree and session. Review all changes before integration.'
});
const out = data => ({ content: [{ type: 'text', text: JSON.stringify(sanitize(data, childEnv), null, 2) }] });
const wrap = fn => async args => { try { return out(await fn(args)); } catch (error) { return { isError: true, content: [{ type: 'text', text: String(sanitize(error.message, childEnv)) }] }; } };
const id = z.string().regex(/^task-[0-9a-f-]{36}$/);
const requestId = z.string().min(1).max(100).optional();
const task = {
  prompt: z.string().min(1).max(100000),
  timeout_seconds: z.number().int().min(10).max(config.maxTimeoutSeconds).optional(),
  max_turns: z.number().int().min(1).max(100).optional(),
  request_id: requestId
};
server.registerTool('pi_health', {
  description: 'Check Pi version, credential presence, roots and capacity without making a provider request.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(async () => ({ ...await manager.health(), config: healthConfig(config) })));
server.registerTool('pi_delegate', {
  description: 'Start a bounded Pi task asynchronously in a dedicated Git worktree from a committed ref.',
  inputSchema: { repository: z.string().min(1), title: z.string().min(1).max(150), ...task,
    base_ref: z.string().min(1).max(250).optional(), mode: z.enum(['implement', 'review']).default('implement'),
    provider: z.string().min(1).max(120).optional(), model: z.string().min(1).max(120).optional(),
    thinking_level: z.string().min(1).max(50).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, wrap(args => manager.start(args)));
server.registerTool('pi_status', {
  description: 'Read job progress and optionally wait up to 45 seconds.',
  inputSchema: { job_id: id, wait_seconds: z.number().min(0).max(45).default(0) }, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(args => manager.status(args.job_id, args.wait_seconds)));
server.registerTool('pi_result', {
  description: 'Read bounded result, errors and Git inventory for a job.', inputSchema: { job_id: id }, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(args => manager.result(args.job_id)));
server.registerTool('pi_list', {
  description: 'List recent jobs across MCP connections.', inputSchema: { limit: z.number().int().min(1).max(50).default(10) }, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(async args => Promise.all((await manager.all()).slice(0, args.limit).map(job => manager.public(job)))));
server.registerTool('pi_cancel', {
  description: 'Request cancellation while preserving the worktree and artifacts.', inputSchema: { job_id: id }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
}, wrap(args => manager.cancel(args.job_id)));
server.registerTool('pi_followup', {
  description: 'Continue a terminal job in its existing worktree and Pi session.', inputSchema: { job_id: id, ...task },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, wrap(({ job_id, ...args }) => manager.start(args, job_id)));
await server.connect(new StdioServerTransport());
