import fs from 'node:fs/promises';
import path from 'node:path';

const readTools = new Set(['read', 'grep', 'find', 'ls']);
const writeTools = new Set(['write', 'edit']);
const pathKeys = ['path', 'file_path', 'filePath', 'directory', 'dir'];

export async function confinedPath(root, candidate, mayCreate = false) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return false;
  const target = path.resolve(root, candidate);
  if (target !== root && !target.startsWith(root + path.sep)) return false;
  const relative = path.relative(root, target).split(path.sep);
  if (relative.some(part => part === '.git' || part === '.pi-mcp-policy')) return false;
  let cursor = target;
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      if (real !== root && !real.startsWith(root + path.sep)) return false;
      const realParts = path.relative(root, real).split(path.sep);
      return !realParts.some(part => part === '.git' || part === '.pi-mcp-policy');
    } catch (error) {
      if (error.code !== 'ENOENT' || !mayCreate) return false;
      const parent = path.dirname(cursor);
      if (parent === cursor) return false;
      cursor = parent;
    }
  }
}

export async function authorizeTool(policy, toolName, input = {}) {
  const deny = reason => ({ allow: false, reason });
  if (!policy || !['implement', 'review'].includes(policy.mode)) return deny('invalid policy');
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
