import fs from 'node:fs/promises';
import path from 'node:path';
import { approvedMcpToolNames, validateToolArguments } from './approved-mcp.mjs';

const readTools = new Set(['read', 'grep', 'find', 'ls']);
const writeTools = new Set(['write', 'edit']);
const pathKeys = ['path', 'file_path', 'filePath', 'directory', 'dir'];
const protectedPart = part => ['.git', '.pi-mcp-policy'].includes(part.toLowerCase());

export async function confinedPath(root, candidate, mayCreate = false) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return false;
  // Pi's path resolver strips these prefixes/whitespace after tool authorization.
  // Reject them so validation and the eventual tool resolve the same filename.
  if (/^[@~]|[^\S\x20\x09\x0a\x0d]|[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/u.test(candidate)) return false;
  const target = path.resolve(root, candidate);
  if (target !== root && !target.startsWith(root + path.sep)) return false;
  const relative = path.relative(root, target).split(path.sep);
  if (relative.some(protectedPart)) return false;
  const canonicalRoot = await fs.realpath(root).catch(() => null);
  if (!canonicalRoot) return false;
  let cursor = root;
  for (const part of relative) {
    if (!part) continue;
    cursor = path.join(cursor, part);
    try {
      await fs.lstat(cursor);
      const real = await fs.realpath(cursor);
      if (real !== canonicalRoot && !real.startsWith(canonicalRoot + path.sep)) return false;
      const realParts = path.relative(canonicalRoot, real).split(path.sep);
      if (realParts.some(protectedPart)) return false;
    } catch (error) {
      // A dangling symlink also produces ENOENT from realpath; lstat detects it.
      if (error.code !== 'ENOENT' || !mayCreate || await fs.lstat(cursor).then(() => true, () => false)) return false;
      break;
    }
  }
  return true;
}

export async function authorizeTool(policy, toolName, input = {}) {
  const deny = reason => ({ allow: false, reason });
  if (!policy || !['implement', 'review'].includes(policy.mode)) return deny('invalid policy');
  if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
    if (!approvedMcpToolNames(policy.approvedMcp, policy.mode).includes(toolName)) return deny('MCP tool unavailable');
    const declaration = policy.approvedMcp?.servers?.flatMap(server => server.tools.map(tool => ({ name: `mcp__${server.id}__${tool.name}`, tool }))).find(entry => entry.name === toolName)?.tool;
    return declaration && validateToolArguments(declaration.inputSchema, input) ? { allow: true } : deny('MCP arguments rejected');
  }
  if (toolName === 'bash') return deny('built-in shell is disabled');
  if (toolName === 'safe_shell') {
    if (policy.mode !== 'implement') return deny('shell unavailable in review mode');
    if (typeof input.command !== 'string' || /\.git(?:\b|[\\/])|(?:^|[;&|()\s])git\s+(?:(?:-C|--git-dir|--work-tree)\s+\S+\s+)*(?:add|am|apply|branch|checkout|cherry-pick|clean|commit|config|fetch|merge|mv|pull|push|rebase|reset|restore|revert|rm|switch|tag|update-ref|worktree)(?:\s|$)/i.test(input.command)) return deny('Git administration/state command is protected');
    return policy.allowedCommands?.includes(input.command)
      ? { allow: true } : deny('command is not exactly allowlisted');
  }
  if (!readTools.has(toolName) && !(policy.mode === 'implement' && writeTools.has(toolName))) return deny('tool unavailable');
  if (toolName === 'grep' && input.path === undefined) input = { ...input, path: '.' };
  if (toolName === 'find' && input.path === undefined) input = { ...input, path: '.' };
  if (toolName === 'ls' && input.path === undefined) input = { ...input, path: '.' };
  const paths = pathKeys.filter(key => input[key] !== undefined).map(key => input[key]);
  if (!paths.length || paths.some(item => typeof item !== 'string')) return deny('path required');
  for (const candidate of paths) {
    if (writeTools.has(toolName) && path.resolve(policy.worktree, candidate) === policy.worktree) return deny('cannot write worktree root');
    if (!await confinedPath(policy.worktree, candidate, writeTools.has(toolName))) return deny('path outside worktree or protected');
  }
  return { allow: true };
}
