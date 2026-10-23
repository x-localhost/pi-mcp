import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateApprovedMcp } from '../src/approved-mcp.mjs';
import { validateGatewayConfig } from '../internal-agent/gateway.mjs';
import { validateInternalProfile } from '../internal-agent/profile.mjs';

test('documented agent and gateway configuration pairs validate with pinned declarations', async () => {
  const markdown = await fs.readFile(new URL('../docs/approved-mcp.md', import.meta.url), 'utf8');
  const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  assert.equal(blocks.length, 4);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'approved-mcp-docs-'));
  const caFile = path.join(tmp, 'ca.pem');
  await fs.writeFile(caFile, 'disposable-test-ca');
  try {
    for (const [agent, gateway] of [[blocks[0], blocks[1]], [blocks[2], blocks[3]]]) {
      assert.equal(validateInternalProfile(agent).model, 'approved-model');
      const declared = validateApprovedMcp(agent.approvedMcp);
      const checked = validateGatewayConfig({ ...gateway, caFile, mcpServers: gateway.mcpServers.map(server => ({ ...server, caFile })) },
        { env: { CORP_LLM_API_KEY: 'test-only', CORP_DOCS_MCP_TOKEN: 'test-only' } });
      assert.equal(agent.model, checked.model);
      assert.deepEqual(declared.servers.filter(server => server.transport === 'internal-http').map(server => ({ id: server.id, tools: server.tools })),
        checked.mcpServers.map(server => ({ id: server.id, tools: server.tools })));
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
