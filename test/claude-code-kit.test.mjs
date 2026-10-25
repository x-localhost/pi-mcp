import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function frontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, 'YAML frontmatter is present');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    assert.ok(field, `supported frontmatter field: ${line}`);
    fields[field[1]] = field[2];
  }
  return fields;
}

test('Claude Code agent and skill frontmatter have required fields', async () => {
  const agent = frontmatter(await read('examples/claude-code/agents/pi-worker.md'));
  const skill = frontmatter(await read('examples/claude-code/skills/pi-delegation/SKILL.md'));
  assert.equal(agent.name, 'pi-worker');
  assert.ok(agent.description);
  assert.equal(agent.model, 'sonnet');
  assert.equal(agent.tools, 'mcp__pi__pi_health, mcp__pi__pi_capabilities, mcp__pi__pi_delegate, mcp__pi__pi_wait, mcp__pi__pi_status, mcp__pi__pi_result, mcp__pi__pi_patch, mcp__pi__pi_events, mcp__pi__pi_followup, mcp__pi__pi_cancel, Read, Grep, Glob');
  assert.equal(skill.name, 'pi-delegation');
  assert.ok(skill.description);
});

test('kit MCP tool names are registered by the server', async () => {
  const files = await Promise.all([
    read('examples/claude-code/agents/pi-worker.md'),
    read('examples/claude-code/skills/pi-delegation/SKILL.md'),
    read('docs/claude-code.md')
  ]);
  const server = await read('src/server.mjs');
  const names = new Set(files.join('\n').match(/mcp__pi__([a-z][a-z0-9_]*)/g) ?? []);
  for (const qualified of names) {
    const name = qualified.slice('mcp__pi__'.length);
    assert.match(server, new RegExp(`registerTool\\('${name}'`), `${name} is registered`);
  }
});

test('agent does not expose forbidden tools', async () => {
  const agent = frontmatter(await read('examples/claude-code/agents/pi-worker.md'));
  for (const forbidden of ['pi_cleanup', 'pi_recover', 'pi_attest_review', 'Bash', 'Edit', 'Write']) {
    assert.ok(!agent.tools.includes(forbidden), `${forbidden} is excluded`);
  }
});

test('host and internal MCP examples contain the pi server', async () => {
  for (const path of ['examples/claude-code/mcp.json', 'examples/claude-code/mcp.internal.json']) {
    const config = JSON.parse(await read(path));
    assert.ok(config.mcpServers.pi, `${path} has mcpServers.pi`);
  }
});
