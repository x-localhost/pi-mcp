# Independent regression — 2026-10-23

Initial immutable input: `69ba7282c76f48c36cf8c1702698a5febf3113a6`.
Corrected immutable input: `4744d1fb6eebe5a2c7cfbabf0e8243a426cef801`.
Latest redaction input: `a9dfdec01116a64ef79e05bc9a7c81edb9ad9e28`.
Assigned checkout: `/Users/leebw/workspace/claude/pi-mcp-worktrees/regression`; latest branch `codex/pi-mcp/regression-redaction`.
Before each phase's writes, `git -C` confirmed repository root, expected branch, exact HEAD, and clean status. Parent committed the supplemental harness in `6bdbc54` and integrated the reviewed source fix before the corrected handoff. In the final two phases, only this report changed in the regression worktree; source and tests were immutable.

## Narrow redaction retest

The latest input changed the worker credential-reference resolver, fake Pi fixture, a focused lifecycle regression, and documentation. After verifying the clean branch and SHA, I extracted the exact committed archive into the task-owned gram directory while retaining unchanged locked dependencies. In the task-only Docker image with `--network none`, both selected lifecycle tests passed: plain model environment reference redaction and braced/embedded reference redaction in result and status. **2 passed, 0 failed; 4.07 seconds.** The previous full suite result below applies to `4744d1f`; it was not rerun for this narrow change.

```sh
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression rev-parse --show-toplevel
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression branch --show-current
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression rev-parse HEAD
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression status --short --untracked-files=all
ssh gram 'find /tmp/pi-mcp-20261023/regression -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +'
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression archive a9dfdec01116a64ef79e05bc9a7c81edb9ad9e28 | ssh gram 'tar -x -C /tmp/pi-mcp-20261023/regression'
ssh gram "docker run --rm --network none --name pi-mcp-regression-redaction-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work pi-mcp-regression-tools:20261023 node --test --test-name-pattern='model env reference|braced and embedded' test/lifecycle.test.mjs"
```

## Corrected-input verification

- On gram, the combined `npm test` suite passed **132/132**, 0 failed, in the task-only rg/fd image with `--network none`. This includes released Pi 1.4.0 against local mock gateways, HTTPS CONNECT/custom CA, all seven MCP tools, cross-process submission, and lifecycle/security coverage.
- The original dangling external and `.git` symlink regressions both passed for `write` and `edit`. The missing-session followup passed, while sibling exclusion also passed. The startup-stall regression ended `timed_out` and observed no live Pi process. The suite also passed new real-Pi `@` path normalization, RPC error cleanup, observed-model, auth-command, and model-only override checks.
- `npm pack --dry-run --json` succeeded on this exact archive: 35 files, 51,163-byte tarball estimate, source/docs/examples/tests only, with no credentials, private state, sessions, or generated fixtures in the file list. Nothing was published. npm printed a `.gitignore` fallback warning because there is no `.npmignore`; this did not fail the dry run.
- No provider credential or paid endpoint was used. `node_modules` was retained from the initial locked install because neither `package.json` nor `package-lock.json` changed between inputs.

Final-phase commands:

```sh
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression rev-parse --show-toplevel
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression branch --show-current
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression rev-parse HEAD
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression status --short --untracked-files=all
ssh gram 'find /tmp/pi-mcp-20261023/regression -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +'
git -C /Users/leebw/workspace/claude/pi-mcp-worktrees/regression archive 4744d1fb6eebe5a2c7cfbabf0e8243a426cef801 | ssh gram 'tar -x -C /tmp/pi-mcp-20261023/regression'
ssh gram 'docker run --rm --network none --name pi-mcp-regression-final-suite-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work pi-mcp-regression-tools:20261023 npm test'
ssh gram 'docker run --rm --network none --name pi-mcp-regression-final-pack-1023 -v /tmp/pi-mcp-20261023/regression:/work -w /work pi-mcp-regression-tools:20261023 npm pack --dry-run --json'
```

The initial failures and their reproduction commands remain below as historical evidence. They are resolved on the corrected input.

## Initial input findings

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
