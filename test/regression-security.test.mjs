import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeTool } from '../src/policy.mjs';

test('write and edit deny dangling symlinks that target outside the worktree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-regression-path-'));
  const worktree = path.join(root, 'worktree');
  const outside = path.join(root, 'outside');
  await fs.mkdir(worktree);
  await fs.mkdir(outside);
  await fs.symlink(path.join(outside, 'new-file.txt'), path.join(worktree, 'outside-link'));
  const policy = { worktree, mode: 'implement', allowedCommands: [] };
  for (const tool of ['write', 'edit']) {
    const decision = await authorizeTool(policy, tool, { path: 'outside-link' });
    assert.equal(decision.allow, false, `${tool} admitted a dangling symlink to an external file`);
  }
});

test('write and edit deny dangling symlinks into Git administration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-regression-git-'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.symlink(path.join(root, '.git', 'new-file'), path.join(root, 'git-link'));
  const policy = { worktree: root, mode: 'implement', allowedCommands: [] };
  for (const tool of ['write', 'edit']) {
    const decision = await authorizeTool(policy, tool, { path: 'git-link' });
    assert.equal(decision.allow, false, `${tool} admitted a dangling symlink into .git`);
  }
});
