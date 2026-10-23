# Independent regression — 2026-10-23

Immutable implementation input: `69ba7282c76f48c36cf8c1702698a5febf3113a6`.
Assigned checkout: `/Users/leebw/workspace/claude/pi-mcp-worktrees/regression`, branch `codex/pi-mcp/regression`.
Before any write, `git -C` confirmed this root, branch, exact HEAD, and a clean status. Implementation and existing tests were not edited. Supplemental harness files under `test/regression-*` and this report are uncommitted and belong only to this test worktree.

## Results

- Committed baseline: `npm test` in gram `node:24.22.0-bookworm`, `--network none`: **106 passed, 0 failed**, including released Pi 1.4.0 mock gateway, HTTPS CONNECT/custom CA, all seven MCP tools, lifecycle and policy tests.
- Independent multi-process tests: **5 passed**. Two separate Node processes simultaneously exercised identical and conflicting `request_id`, global concurrency, and sibling followup exclusion. A separate isolation check confirmed selected commit checkout excludes tracked dirty, untracked, and ignored source files without changing the source checkout.
- Actual Pi grep/find acceptance: **1 passed**. In a task-only Docker image with ripgrep and fd, Pi 1.4.0 made three requests to a local mock gateway. The second request contained the real grep result (`RegressionNeedle`); the third contained the real find result (`target.txt`). Terminal status was `completed`. `pi_health` reported rg/fd present and made zero gateway requests.
- Security regression: **2 failed**. `authorizeTool` admits `write` for a dangling symlink inside the worktree pointing to a new external file, and another pointing to a new `.git` file. `edit` was not reached because `write` failed first. `confinedPath` handles `realpath` `ENOENT` by walking the lexical parent, losing the symlink target. This can route a permitted write outside the worktree or into Git administration.
- Followup recovery: **1 failed**. A terminal parent with a valid worktree and no recorded session rejects a fresh followup with `Parent session unavailable` at `src/manager.mjs:152`. Recorded-session sibling exclusion passed.
- RPC edge checks: **2 passed**. A malformed line did not satisfy a pending correlated response; an oversized line rejected the pending request promptly. Startup deadline check **failed**: a Pi stub that reported version 1.4.0 but never acknowledged policy readiness reached the 10-second watchdog, then finished as `failed` with `write EPIPE` despite `lastProgress: Stopping: timed_out`. Expected terminal status was `timed_out`.
- `npm pack --dry-run --json` succeeded. Its file list contained source, docs, examples, tests, and the supplemental test files copied to the remote test tree; it contained no credential, private state, or generated session file. No package was published.

The base `node:24.22.0-bookworm` image has Git but no rg/fd. Successful grep/find behavior therefore required the task-only image above; the committed baseline alone did not exercise it.

## Commands and environment

Local verification before writes:

```sh
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression rev-parse --show-toplevel
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression branch --show-current
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression rev-parse HEAD
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression status --short --untracked-files=all
```

Remote input and dependency setup:

```sh
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression archive 69ba7282c76f48c36cf8c1702698a5febf3113a6 | ssh gram 'mkdir -p /tmp/pi-mcp-20261023/regression && tar -x -C /tmp/pi-mcp-20261023/regression'
ssh gram 'docker run --rm --name pi-mcp-regression-npmci-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work node:24.22.0-bookworm npm ci --ignore-scripts --no-audit --no-fund'
```

Remote checks (all test containers used `--network none`; no published ports):

```sh
ssh gram 'docker run --rm --network none --name pi-mcp-regression-suite-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work node:24.22.0-bookworm npm test'
ssh gram 'docker run --rm --network none --name pi-mcp-regression-security-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work node:24.22.0-bookworm node --test test/regression-security.test.mjs'
ssh gram 'docker run --rm --network none --name pi-mcp-regression-process-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work node:24.22.0-bookworm node --test test/regression-process.test.mjs'
ssh gram 'docker run --rm --network none --name pi-mcp-regression-followup-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work node:24.22.0-bookworm node --test --test-name-pattern="terminal parent with no recorded session" test/regression-process.test.mjs'
ssh gram 'docker run --rm --network none --name pi-mcp-regression-pack-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work node:24.22.0-bookworm npm pack --dry-run --json'
ssh gram 'docker run --rm --network none --name pi-mcp-regression-real-tools-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work pi-mcp-regression-tools:20261023 node --test test/regression-real-tools.test.mjs'
ssh gram 'docker run --rm --network none --name pi-mcp-regression-rpc-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work node:24.22.0-bookworm node --test test/regression-rpc.test.mjs'
```

The tool image was made in a task-owned container using `apt-get install ripgrep fd-find`, with `/usr/local/bin/fd` pointing to `/usr/bin/fdfind`; it was committed to task-only image `pi-mcp-regression-tools:20261023`. The install container was removed. The image and `/tmp/pi-mcp-20261023/regression` can be removed after integration/retest. No shared host configuration was changed.

Files inspected: `AGENTS.md`, `docs/plan.md`, `README.md`, `docs/core-unit-report.md`, `package.json`, `examples/{config,mcp,models}.example.json`, `docs/corporate-setup.md`, `src/{manager,worker,rpc,policy,server}.mjs`, `test/{manager,lifecycle,core,real-pi,real-policy,proxy-pi}.test.mjs`, `test/fixtures/fake-pi.mjs`, and installed Pi 1.4.0 `dist/core/{model-config,tools/grep,tools/find}.js` on gram.

No paid provider request or real credential was used. External corporate proxy/auth acceptance remains outside this isolated regression.
