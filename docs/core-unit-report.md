# Core unit report — 2026-10-23

Worktree: `/Users/leebw/workspace/claude/pi-mcp-worktrees/core`, branch `codex/pi-mcp/core`. Started from committed plan base `340acce9efbdba88a4331ea7ed00c5029d9e5fde`; parent supplied committed config dependency on this branch as `686836d630408a9c91c20737b0b7af91b7b8ae45`. No core commit, merge, push or live MCP setting change was made by this unit.

## Files owned and changed

- `package.json`, `package-lock.json`
- `src/manager.mjs`, `src/policy-extension.mjs`, `src/policy.mjs`, `src/rpc.mjs`, `src/sanitize.mjs`, `src/server.mjs`, `src/worker.mjs`
- `test/core.test.mjs`, `test/fixtures/fake-pi.mjs`, `test/lifecycle.test.mjs`, `test/manager.test.mjs`, `test/mcp.test.mjs`, `test/proxy-pi.test.mjs`, `test/real-pi.test.mjs`, `test/real-policy.test.mjs`
- `README.md`, `docs/parity.md`, `docs/core-unit-report.md`

The config worker owns `src/config.mjs`, `test/config.test.mjs`, `examples/*`, `docs/corporate-setup.md` and `docs/config-unit-report.md`; this core unit did not edit them.

## TDD and verification

All installs and tests ran on `gram` in task-owned `/tmp/pi-mcp-20261023/core` with `node:24.22.0-bookworm` Docker containers, no published ports. Source synchronization used `rsync -a --exclude=.git --exclude=node_modules` from this worktree to that remote directory.

- Initial `node --test test/core.test.mjs` RED failed with `ERR_MODULE_NOT_FOUND` for `src/policy.mjs`; this was an interface setup failure and is **not** counted as behavior RED.
- Added a `Manager` placeholder constructor. `node --test test/manager.test.mjs` RED failed on `Manager lifecycle not implemented`, the expected missing behavior.
- `node --test test/core.test.mjs test/manager.test.mjs` GREEN: 3/3 passed after implementation.
- `node --test test/lifecycle.test.mjs` GREEN: detached settlement/followup, provider error/cancel and worker-death quarantine passed. A later stale-observer regression test passed as well.
- `node --test test/real-pi.test.mjs` GREEN against released Pi 1.4.0 and a local mock OpenAI-compatible gateway; it exercised an actual read call and `agent_settled`.
- `node --test test/real-policy.test.mjs` GREEN after a discovered cancellation observation race was fixed; actual Pi exercised write, edit, exact `safe_shell`, review denial, protected Git path denial and cancellation of a shell process group.
- `node --test test/mcp.test.mjs` GREEN: all seven tools through the official MCP stdio client, reconnect, idempotent retry, result, list, followup and cancel.
- `node --test test/proxy-pi.test.mjs` GREEN: actual Pi used a task-local HTTP CONNECT proxy to a self-signed HTTPS model gateway with configured CA and provider key. Removing the CA yielded a non-success terminal job, CONNECT attempts, and zero HTTPS gateway requests; Pi retried until its turn limit, so the negative status was `turn_limit` in the observed run.
- `npm ci --ignore-scripts --no-audit --no-fund` GREEN: 207 packages installed from the lockfile.
- Final `npm test` GREEN: **106 tests passed, 0 failed** (15 suites, about 12.7 seconds). This includes the config worker's 92 tests on the supplied committed dependency.

## Remaining external acceptance

No corporate provider endpoint or real company credential was available. `pi_health` checks credential presence only. Company proxy authentication, CA chain, actual provider model behavior and OAuth refresh against the organization's service still need validation in that environment. The mock HTTPS/CONNECT path and local authenticated gateway were verified without any paid provider request.

The policy guards Pi tools and exact administrator-approved shell commands; it is not an OS sandbox. A trusted command may execute repository scripts. An orphaned worker is quarantined rather than signaling an unverified numeric PID, preserving its concurrency slot for operator inspection.
