# Workflow unit report — 2026-10-24

## Scope and base

Worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness-workflow`, branch `codex/harness/workflow`. Started from `ede7f5664a5e98eabb4fd1fd3c5f476343d104a2`; parent fast-forwarded the clean committed dependency to `0985441740bf26c63d2fc34a67399bfb10c640d2` before the narrow Manager cleanup edit. No commit, push, live service, model endpoint, or global setting change was made in this unit.

Changed files: `src/workflow.mjs`, `src/manager.mjs` (cleanup import and reference check only), `scripts/workflow.mjs`, `test/harness-workflow.test.mjs`, `test/fixtures/workflow-child.mjs`, `docs/harness-workflow.md`, and this report.

## Behavior

The workflow stores up to 16 immutable sequential stages and a private bounded plan. Each stage gets a deterministic request ID and payload/source digest intent persisted before Manager submission. Admission uses a goal lock followed by Manager's submit lock; submission happens after releasing the submit lock. Restart reconciliation checks the request ID, source CODE/contract digests and child provenance. Cleanup holds the submit lock and refuses jobs referenced by either stored job ID or prepared request ID. A separate no-follow, bounded reference reader does not take the workflow lock; atomic temp files live in the workflow locks directory so cleanup never mistakes them for stores.

The public status omits prompts and reports stage/child IDs, source checkpoint and contract digests, truthful next action, block reason, and observed usage. Unknown usage dimensions are `null`; configured budget admission fails closed, while an in-flight child can overshoot. Review can run while source acceptance awaits review, but later implementation and final goal completion wait for fresh Manager acceptance. Review prose is never approved automatically. Cancellation intent is saved before delivery and retried after restart; release requires a completed or cancelled goal with no active child. The CLI has explicit `create/status/advance/cancel/release` operations and loads only configured Manager settings.

## Verification

- RED: On gram, `node --test /app/test/harness-workflow.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for `src/workflow.mjs` before implementation.
- GREEN: Synced `src test internal-agent scripts docs examples package.json package-lock.json` by tar/SSH to `/tmp/pi-harness-implementation-20261024/workflow/tree`, then ran `docker run --rm --network none` using `pi-harness-implementation:test-20261024` with the synced `/app/src`, `/app/test`, `/app/internal-agent` mounts and `node --test /app/test/harness-workflow.test.mjs`. Final result: **18 passed, 0 failed**. This covers two OS processes racing to advance one goal, crash/restart and orphan child reconciliation, cancellation retry, review and rollover provenance, budget unknown/unique counts, final acceptance, safe release, bounded/corrupt/symlink stores, and a real Manager acceptance/cleanup boundary with mock provider and no worker spawn.
- Existing cleanup regression: same remote image and mounts with `node --test --test-name-pattern=cleanup /app/test/completion-runtime.test.mjs /app/test/harness-runtime-manager.test.mjs`: **3 passed, 0 failed**.

The real Manager test simulates a terminal job by writing a private test fixture job record; it does not invoke Pi, an MCP, or a provider. A full suite and any end-to-end paid/model session remain parent integration work.
