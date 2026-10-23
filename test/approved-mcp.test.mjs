import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApprovedMcp, approvedMcpToolNames, validateToolArguments, registerApprovedMcp } from '../src/approved-mcp.mjs';
import { authorizeTool } from '../src/policy.mjs';

const readSchema = { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['path'], additionalProperties: false };
const server = { id: 'docs', transport: 'internal-http', backendAttested: true, tools: [{ name: 'read', description: 'Read a document', inputSchema: readSchema }, { name: 'write', description: 'Write a document', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }], reviewTools: ['read'] };

test('approved MCP is disabled by default and normalizes exact admin declarations', () => {
  assert.deepEqual(validateApprovedMcp(undefined), { servers: [] });
  const config = validateApprovedMcp({ servers: [server] });
  assert.deepEqual(approvedMcpToolNames(config, 'implement'), ['mcp__docs__read', 'mcp__docs__write']);
  assert.deepEqual(approvedMcpToolNames(config, 'review'), ['mcp__docs__read']);
  assert.equal(config.servers[0].route, '/internal-mcp/docs');
  assert.equal(config.servers[0].tools[0].inputSchema.additionalProperties, false);
});

test('MCP declaration rejects hidden routes, duplicate names, undeclared review tools and unsafe schemas', () => {
  for (const raw of [
    { servers: [{ ...server, extra: 'x' }] },
    { servers: [server, server] },
    { servers: [{ ...server, reviewTools: ['missing'] }] },
    { servers: [{ ...server, backendAttested: false }] },
    { servers: [{ ...server, tools: [{ name: 'read', description: 'x', inputSchema: { $ref: 'https://outside.invalid/schema' } }] }] },
    { servers: [{ ...server, tools: [{ name: 'read', description: 'x', inputSchema: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: true } }] }] },
    { servers: [
      { ...server, id: 'a__b', tools: [{ name: 'c', description: 'One', inputSchema: readSchema }], reviewTools: ['c'] },
      { ...server, id: 'a', tools: [{ name: 'b__c', description: 'Two', inputSchema: readSchema }], reviewTools: ['b__c'] },
    ] },
  ]) assert.throws(() => validateApprovedMcp(raw), /approved mcp/i);
});

test('approved tool arguments are checked locally against the pinned bounded schema', () => {
  const schema = validateApprovedMcp({ servers: [server] }).servers[0].tools[0].inputSchema;
  assert.equal(validateToolArguments(schema, { path: 'guide.md' }), true);
  for (const args of [{}, { path: '' }, { path: 'x', url: 'https://outside.invalid' }, { path: 7 }]) {
    assert.equal(validateToolArguments(schema, args), false);
  }
});

test('policy authorizes only declared MCP tools and explicit review list', async () => {
  const approvedMcp = validateApprovedMcp({ servers: [server] });
  const policy = { mode: 'review', approvedMcp, worktree: '/tmp/review' };
  assert.equal((await authorizeTool(policy, 'mcp__docs__read', { path: 'guide.md' })).allow, true);
  assert.equal((await authorizeTool(policy, 'mcp__docs__write', { text: 'x' })).allow, false);
  assert.equal((await authorizeTool(policy, 'mcp__docs__unknown', {})).allow, false);
  assert.equal((await authorizeTool({ ...policy, mode: 'implement' }, 'mcp__docs__write', { text: 'x' })).allow, true);
  const ambiguous = validateApprovedMcp({ servers: [{ ...server, id: 'a', tools: [{ name: 'b__c', description: 'Read', inputSchema: readSchema }], reviewTools: ['b__c'] }] });
  assert.equal((await authorizeTool({ ...policy, approvedMcp: ambiguous }, 'mcp__a__b__c', { path: 'guide.md' })).allow, true);
});

test('root-owned packaged stdio MCP discovers and executes without inheriting Pi credentials', async () => {
  const stdio = { id: 'docs', transport: 'stdio', command: '/usr/local/bin/node', args: ['/app/approved-mcp/mock.mjs'], cwd: '/app/approved-mcp', env: {},
    tools: [{ name: 'read', description: 'Read a document', inputSchema: readSchema }], reviewTools: ['read'] };
  const old = process.env.PI_SECRET_TEST;
  process.env.PI_SECRET_TEST = 'must-not-reach-server';
  const registered = [];
  let session;
  try {
    session = await registerApprovedMcp({ getAllTools: () => [], registerTool: tool => registered.push(tool) }, { mode: 'review', approvedMcp: { servers: [stdio] } });
    assert.deepEqual(session.toolNames, ['mcp__docs__read']);
    assert.deepEqual((await registered[0].execute('call', { path: 'guide.md' })).content, [{ type: 'text', text: 'DOC:guide.md' }]);
  } finally {
    await session?.close();
    if (old === undefined) delete process.env.PI_SECRET_TEST; else process.env.PI_SECRET_TEST = old;
  }
});

test('packaged stdio path rejects symlink ancestors and trailing dot components', async () => {
  const base = { id: 'docs', transport: 'stdio', command: '/usr/local/bin/node', args: ['/app/approved-mcp/mock.mjs'], cwd: '/app/approved-mcp', env: {},
    tools: [{ name: 'read', description: 'Read a document', inputSchema: readSchema }], reviewTools: ['read'] };
  const pi = { getAllTools: () => [], registerTool: () => {} };
  await assert.rejects(registerApprovedMcp(pi, { mode: 'review', approvedMcp: { servers: [{ ...base, cwd: '/app/approved-mcp/.' }] } }), /immutable and packaged/i);
  await assert.rejects(registerApprovedMcp(pi, { mode: 'review', approvedMcp: { servers: [{ ...base, args: ['/app/approved-mcp/link/mock.mjs'] }] } }), /immutable and packaged/i);
});
