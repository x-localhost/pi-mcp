#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, buildChildEnv, healthConfig } from './config.mjs';
import { Manager } from './manager.mjs';
import { sanitize } from './sanitize.mjs';
import { capabilities } from './capabilities.mjs';

process.umask(0o077);
const config = await loadConfig();
const childEnv = buildChildEnv(config);
const manager = await new Manager(config, childEnv).init();
await manager.ensureDispatcher();
const mcpSecrets = config.approvedMcp.servers.flatMap(server => Object.values(server.env || {}));
const server = new McpServer({ name: 'pi-mcp', version: '0.1.0' }, {
  instructions: 'Start with pi_health and pi_capabilities. Delegation queues a bounded job from a committed ref. Poll pi_status and pi_events; pi_result is a preview and pi_artifacts/pi_read_artifact expose complete bounded exports. request_id makes retries idempotent. Followups resume the current unsealed session or roll over long history into a fresh code-preserving session; forks use immutable terminal checkpoints. Inspect verification and acceptance separately and review all changes before integration. A subagent loop is typically pi_delegate, then pi_wait, then pi_result, then pi_patch (metadata first with include_text:false), then review, then apply in a clean local worktree; waits beyond 45 seconds need a client request timeout that allows them.'
});
// Manager and artifact/event owners sanitize untrusted text before returning it.
// Re-sanitizing the whole structured response can corrupt IDs, enum statuses,
// digests and base64 when a short configured secret happens to match them.
const out = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const wrap = fn => async (args, extra) => { try { return out(await fn(args, extra)); } catch (error) { return { isError: true, content: [{ type: 'text', text: String(sanitize(error.message, childEnv, mcpSecrets)) }] }; } };
const id = z.string().regex(/^task-[0-9a-f-]{36}$/);
const requestId = z.string().min(1).max(100).optional();
const inlineImage = z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), data: z.string().max(1398104) }).strict();
const acceptance = z.object({ version: z.literal(1), required_verification_ids: z.array(z.string()).max(32).optional(), required_artifact_paths: z.array(z.string()).max(32).optional(), require_review: z.boolean().optional() }).strict();
const task = {
  prompt: z.string().min(1).max(100000),
  timeout_seconds: z.number().int().min(10).max(config.maxTimeoutSeconds).optional(),
  max_turns: z.number().int().min(1).max(100).optional(),
  images: z.array(inlineImage).max(4).optional(),
  materials: z.array(z.string()).max(32).optional(),
  verification_ids: z.array(z.string()).max(8).optional(),
  acceptance: acceptance.optional(),
  request_id: requestId
};
server.registerTool('pi_health', {
  description: 'Check Pi version, credential presence, roots and capacity without making a provider request.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(async () => ({ ...await manager.health(), config: healthConfig(config) })));
server.registerTool('pi_capabilities', {
  description: 'Discover safe versioned model, verifier, material, mode, continuation, contract and limit metadata.',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(() => capabilities(config)));
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
server.registerTool('pi_wait', {
  description: 'Wait up to 300 seconds for one or more jobs to settle (terminal or quarantined). For a fan-out with until:any, drop settled job_ids before the next call.',
  inputSchema: { job_ids: z.array(id).min(1).max(8), wait_seconds: z.number().min(0).max(300).default(45), until: z.enum(['any', 'all']).default('any') },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap((args, extra) => manager.wait(args.job_ids, {
  waitSeconds: args.wait_seconds, until: args.until, signal: extra.signal,
  onProgress: extra._meta?.progressToken !== undefined ? async progress => { try { await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, ...progress } }); } catch {} } : undefined
})));
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
  description: 'Continue the latest terminal job in its unsealed session, automatically using a fresh code-preserving session near the raw-history limit.', inputSchema: { job_id: id, ...task },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, wrap(({ job_id, ...args }) => manager.start(args, job_id)));
server.registerTool('pi_fork', {
  description: 'Fork a terminal job from its immutable source and Pi session checkpoints into a distinct worktree/session.',
  inputSchema: { job_id: id, ...task }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, wrap(({ job_id, ...args }) => manager.fork(job_id, args)));
server.registerTool('pi_review', {
  description: 'Review a terminal immutable code checkpoint in a fresh read-only Pi session and separate worktree; findings are advisory.',
  inputSchema: { job_id: id, ...task }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, wrap(({ job_id, ...args }) => manager.review(job_id, args)));
server.registerTool('pi_rollover', {
  description: 'Continue immutable terminal code in a fresh session with a bounded structured handoff.',
  inputSchema: { job_id: id, ...task }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, wrap(({ job_id, ...args }) => manager.rollover(job_id, args)));
server.registerTool('pi_attest_review', {
  description: 'Record an explicit caller-authority review verdict bound to source, snapshot, contract and completed review job. Caller identity is not authenticated.',
  inputSchema: { job_id: id, review_job_id: id, verdict: z.enum(['approved', 'rejected']), request_id: z.string().min(1).max(100) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
}, wrap(({ job_id, ...args }) => manager.attestReview(job_id, args)));
server.registerTool('pi_events', {
  description: 'Read bounded sanitized persisted progress events by cursor; gaps are explicit.',
  inputSchema: { job_id: id, cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(args => manager.events(args.job_id, args)));
server.registerTool('pi_steer', {
  description: 'Queue a bounded steering message for a running worker and report its acknowledgement state.',
  inputSchema: { job_id: id, message: z.string().min(1).max(2000), images: z.array(inlineImage).max(4).optional() }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, wrap(({ job_id, ...args }) => manager.steer(job_id, args)));
server.registerTool('pi_artifacts', {
  description: 'Page through a terminal job public artifact manifest and omissions.',
  inputSchema: { job_id: id, cursor: z.string().optional(), omission_cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) }, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(({ job_id, omission_cursor, ...options }) => manager.artifacts(job_id, { ...options, omissionCursor: omission_cursor ?? null })));
server.registerTool('pi_read_artifact', {
  description: 'Read exact public artifact bytes in bounded base64 pages with hashes.',
  inputSchema: { job_id: id, artifact_id: z.string().regex(/^a\d{6}$/), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(config.artifacts.maxReadBytes).default(Math.min(65536, config.artifacts.maxReadBytes)) }, annotations: { readOnlyHint: true, openWorldHint: false }
}, wrap(({ job_id, ...options }) => manager.readArtifact(job_id, options)));
server.registerTool('pi_recover', {
  description: 'Inspect a quarantined job; explicitly terminate only groups with verified Linux ownership.',
  inputSchema: { job_id: id, terminate: z.boolean().default(false) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
}, wrap(({ job_id, terminate }) => manager.recoverJob(job_id, { terminate })));
server.registerTool('pi_cleanup', {
  description: 'Dry-run safe owned terminal job cleanup; execution requires explicit dry_run=false.',
  inputSchema: { job_ids: z.array(id).max(100).default([]), older_than_days: z.number().int().min(0).max(3650).optional(), dry_run: z.boolean().default(true) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
}, wrap(args => manager.cleanup(args)));
await server.connect(new StdioServerTransport());
