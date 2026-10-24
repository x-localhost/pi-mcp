import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeObservation, createObservation } from '../src/observation.mjs';
import { normalizeContext, reduceContext, guardProviderPayload } from '../src/context-policy.mjs';
import { POLICY_READY_TIMEOUT_MS, registerApprovedMcp } from '../src/approved-mcp.mjs';

test('strict bounded tool configuration and readiness budget', () => {
  assert.deepEqual(normalizeContext(), { maxMessages: 112, maxBytes: 3_500_000 });
  assert.deepEqual(normalizeObservation(), { maxEvents: 256, maxBytes: 65_536, idleTimeoutMs: 0, consecutiveFailureLimit: 0 });
  assert.ok(POLICY_READY_TIMEOUT_MS >= 28_000);
  for (const raw of [{ maxBytes: 4_000_000 }, { maxMessages: 128 }, { extra: true }]) assert.throws(() => normalizeContext(raw));
  for (const raw of [{ maxEvents: 10000 }, { idleTimeoutMs: -1 }, { maxBytes: 1 }, { extra: true }]) assert.throws(() => normalizeObservation(raw));
});

test('context reduction drops complete old tool groups and retains mandatory context', () => {
  const system = { role: 'system', content: 'AUTHORITY', toolsAdded: [{ name: 'read', description: 'tool' }] };
  const first = { role: 'user', content: 'Original task' };
  const old = { role: 'assistant', content: 'x'.repeat(70_000) };
  const call = { role: 'assistant', toolCalls: [{ id: 'secret-call-id', name: 'read', arguments: {} }] };
  const result = { role: 'toolResult', toolCallId: 'secret-call-id', toolName: 'read', content: [{ type: 'text', text: 'secret-result' }] };
  const latest = { role: 'user', content: 'Latest request' };
  const reduced = reduceContext([system, first, old, call, result, latest], { maxMessages: 8, maxBytes: 65_536 });
  assert.equal(reduced.ok, true);
  assert.equal(reduced.messages[0], system);
  assert.equal(reduced.messages[1], first);
  assert.equal(reduced.messages.at(-1), latest);
  assert.equal(reduced.messages.some(message => message === call), reduced.messages.some(message => message === result));
  assert.ok(reduced.droppedMessages > 0);
  assert.equal(reduceContext([system, first, latest], { maxMessages: 8, maxBytes: 65_536 }).ok, true);
  assert.equal(reduceContext([system, { role: 'user', content: 'x'.repeat(90_000) }], { maxMessages: 8, maxBytes: 65_536 }).ok, false);
  const crowded = [system, first, ...Array.from({ length: 140 }, (_, index) => ({ role: 'assistant', content: String(index) })), latest];
  const bounded = reduceContext(crowded, normalizeContext());
  assert.equal(bounded.ok, true);
  assert.ok(bounded.messages.length <= 112);
  const tools = [{ type: 'function', function: { name: 'read', description: 'x'.repeat(70_000) } }];
  assert.equal(guardProviderPayload({ messages: [system, first, latest], tools }, { maxMessages: 8, maxBytes: 65_536 }).ok, false);
  const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(70_000)}` } }] };
  assert.equal(guardProviderPayload({ messages: [system, first, image] }, { maxMessages: 8, maxBytes: 65_536 }).ok, false);
  const piCall = { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: {} }, { type: 'toolCall', id: 'b', name: 'read', arguments: {} }] };
  const piResultA = { role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'A'.repeat(70_000) }] };
  const piResultB = { role: 'toolResult', toolCallId: 'b', content: [{ type: 'text', text: 'B' }] };
  const group = reduceContext([system, first, piCall, piResultA, piResultB, latest], { maxMessages: 8, maxBytes: 65_536 });
  assert.equal(group.ok, true);
  assert.equal(group.messages.includes(piCall), false);
  assert.equal(group.messages.includes(piResultA), false);
  assert.equal(group.messages.includes(piResultB), false);
  assert.equal(reduceContext([system, first, piCall, piResultA, latest], { maxMessages: 8, maxBytes: 65_536 }).ok, false);
  const anthropic = { messages: [first, { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'A'.repeat(70_000) }] }, latest], system: 'rules' };
  const anthropicReduced = guardProviderPayload(anthropic, { maxMessages: 8, maxBytes: 65_536 });
  assert.equal(anthropicReduced.ok, true);
  assert.equal(anthropicReduced.payload.messages.length, 2);
  assert.equal(guardProviderPayload({ input: [first], model: 'response-model' }, { maxMessages: 8, maxBytes: 65_536 }).ok, true);
});

test('context reduction retains every user instruction in native and provider forms', () => {
  const system = { role: 'system', content: 'Rules' };
  const first = { role: 'user', content: 'A' };
  const middle = { role: 'user', content: 'Preserve C' };
  const latest = { role: 'user', content: 'Continue' };
  const old = { role: 'assistant', content: 'x'.repeat(70_000) };
  const reduced = reduceContext([system, first, old, middle, latest], { maxMessages: 8, maxBytes: 65_536 });
  assert.equal(reduced.ok, true);
  assert.equal(reduced.messages.includes(middle), true);
  const impossible = reduceContext([system, first, { role: 'user', content: 'C'.repeat(70_000) }, latest], { maxMessages: 8, maxBytes: 65_536 });
  assert.equal(impossible.ok, false);
  const provider = guardProviderPayload({ messages: [first, old, middle, latest] }, { maxMessages: 8, maxBytes: 65_536 });
  assert.equal(provider.ok, true);
  assert.equal(provider.payload.messages.includes(middle), true);
});

test('observation progress ignores compaction starts and repeated reductions', async () => {
  const observer = createObservation({});
  const start = observer.snapshot().lastProgressAt;
  await observer.record('compaction', { outcome: 'started' });
  await observer.record('context_reduction', { droppedMessages: 1 });
  await observer.record('compaction', { outcome: 'failed' });
  assert.equal(observer.snapshot().lastProgressAt, start);
  await observer.record('assistant_progress');
  assert.notEqual(observer.snapshot().lastProgressAt, start);
});

test('observation writes only allowlisted metadata and tracks progress separately', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'harness-observation-'));
  try {
    const observationFile = join(dir, 'events.jsonl');
    const activityFile = join(dir, 'activity.json');
    const stopFile = join(dir, 'stop.json');
    const observer = createObservation({ observationFile, activityFile, stopFile, jobId: '11111111-1111-4111-8111-111111111111', policy: { maxEvents: 4, maxBytes: 2048, idleTimeoutMs: 0, consecutiveFailureLimit: 2 } });
    await observer.record('heartbeat', { prompt: 'SENTINEL', arguments: 'SENTINEL' });
    await observer.record('tool_start', { toolName: 'read', toolCallId: 'SENTINEL', args: 'SENTINEL' });
    await observer.record('tool_end', { toolName: 'read', isError: true, durationMs: 5, result: 'SENTINEL' });
    await observer.record('tool_end', { toolName: 'read', isError: true, durationMs: 6, result: 'SENTINEL' });
    const records = await readFile(observationFile, 'utf8');
    assert.ok(!records.includes('SENTINEL'));
    assert.ok(records.split('\n').filter(Boolean).length <= 4);
    const activity = JSON.parse(await readFile(activityFile, 'utf8'));
    assert.equal(activity.version, 1);
    assert.equal(activity.consecutiveToolFailures, 2);
    assert.ok(activity.lastProgressAt);
    assert.equal(JSON.parse(await readFile(stopFile, 'utf8')).reason, 'repeated_tool_failure');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('active approved HTTP servers start concurrently within one three-stage deadline', { timeout: 33_000 }, async () => {
  const http = await import('node:http');
  const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const descriptions = { one: 'One', two: 'Two', unused: 'Unused' };
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ route: req.url, method: body.method });
    if (body.method !== 'tools/call') await new Promise(resolve => setTimeout(resolve, 6000));
    if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    const id = req.url.split('/').at(-1);
    const result = body.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: id, version: '1' } } : body.method === 'tools/list' ? { tools: [{ name: 'lookup', description: descriptions[id], inputSchema: schema }] } : { content: [{ type: 'text', text: 'ok' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise(resolve => server.listen(18080, '127.0.0.1', resolve));
  try {
    const registrations = [];
    const pi = { getAllTools: () => [], registerTool: tool => registrations.push(tool) };
    const config = { servers: Object.entries(descriptions).map(([id, description]) => ({ id, transport: 'internal-http', backendAttested: true, tools: [{ name: 'lookup', description, inputSchema: schema }], reviewTools: id === 'unused' ? [] : ['lookup'] })) };
    const start = Date.now();
    const session = await registerApprovedMcp(pi, { approvedMcp: config, mode: 'review' });
    assert.ok(Date.now() - start >= 18_000);
    assert.ok(Date.now() - start < 24_000);
    assert.deepEqual(session.toolNames.sort(), ['mcp__one__lookup', 'mcp__two__lookup']);
    assert.equal(registrations.length, 2);
    assert.deepEqual(new Set(seen.map(entry => entry.route)), new Set(['/internal-mcp/one', '/internal-mcp/two']));
    assert.equal(seen.length, 6);
    await new Promise(resolve => setTimeout(resolve, 7_100));
    assert.equal((await registrations[0].execute('opaque', {}, undefined)).content[0].text, 'ok');
    assert.equal(seen.length, 7);
    await session.close();
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('failed approved startup aborts siblings, settles attempts and closes a late success', async () => {
  const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const config = { servers: ['one', 'two'].map(id => ({ id, transport: 'internal-http', backendAttested: true, tools: [{ name: 'lookup', description: 'Lookup', inputSchema: schema }], reviewTools: ['lookup'] })) };
  const seen = [];
  const pi = { getAllTools: () => [], registerTool: () => { throw new Error('must not register'); } };
  await assert.rejects(registerApprovedMcp(pi, { mode: 'review', approvedMcp: config }, { connectSession: async (server, signal) => {
    if (server.id === 'one') { await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('startup failed'); }
    await new Promise(resolve => setTimeout(resolve, 30));
    seen.push({ aborted: signal.aborted });
    return { call: async () => ({}), close: async () => { seen.push({ closed: true }); } };
  } }), /startup failed/);
  assert.deepEqual(seen, [{ aborted: true }, { closed: true }]);
});
