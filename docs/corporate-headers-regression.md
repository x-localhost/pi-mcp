# Corporate headers independent regression — 2026-10-23

Immutable input: `91a8cdeba2fb31314e02fcef95dfc8727e78091e` (committed base `18f804844484a4e06a59527d8bbd17c12dc1fc21`). Assigned checkout: `/Users/leebw/workspace/claude/pi-mcp-worktrees/corporate-headers-regression`, branch `codex/corporate-headers/regression`. Before writing, `git -C` confirmed this root, branch, exact HEAD, and clean tracked/untracked status. No implementation or existing test file was edited.

## Result

The full `npm test` suite passed on gram: **171 tests passed, 0 failed, 0 skipped**, 15 suites, 30.67 seconds. It included actual Pi 1.4.0 mock-gateway requests carrying multiple custom provider/model headers across a tool round trip, custom Authorization precedence, header validation and redaction, HTTPS CONNECT/custom CA, all seven MCP stdio tools, and earlier process/security regressions. The tests used loopback mock services only; no real company endpoint, credential, or paid model API was contacted. Corporate endpoint authentication remains unverified.

The run used `pi-mcp-headers-tools:20261023` (Node 24.22.0 bookworm with rg/fd), `--network none`, no published ports, and read-only dependencies from the task's existing implementation directory. No local build, install, or test was run. Full output is at `/tmp/pi-mcp-headers-20261023/regression/npm-test.log` on gram. Parent owns cleanup of that task-owned remote directory; no active test container remains.

## Exact commands

```sh
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/corporate-headers-regression rev-parse --show-toplevel
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/corporate-headers-regression branch --show-current
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/corporate-headers-regression rev-parse HEAD
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/corporate-headers-regression status --short --untracked-files=all
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/corporate-headers-regression archive 91a8cdeba2fb31314e02fcef95dfc8727e78091e | ssh gram 'mkdir -p /tmp/pi-mcp-headers-20261023/regression && tar -x -C /tmp/pi-mcp-headers-20261023/regression'
ssh gram 'docker run --rm --network none --name pi-mcp-headers-regression-1023 -v /tmp/pi-mcp-headers-20261023/regression:/app -v /tmp/pi-mcp-headers-20261023/implementation/node_modules:/app/node_modules:ro -w /app pi-mcp-headers-tools:20261023 npm test > /tmp/pi-mcp-headers-20261023/regression/npm-test.log 2>&1'
ssh gram 'tail -n 65 /tmp/pi-mcp-headers-20261023/regression/npm-test.log'
```

Files inspected: `AGENTS.md`, `docs/corporate-headers-plan.md`, `docs/corporate-headers-report.md`, `package.json`, the changed-file inventory from `18f8048` to `91a8cde`, and test names in `test/headers.test.mjs` and `test/real-pi-headers.test.mjs`. Source invariant check: `git diff -- src test` was empty; only this report was written in the assigned checkout.
