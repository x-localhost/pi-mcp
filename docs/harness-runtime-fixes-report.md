# Runtime review corrections — 2026-10-24

Worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness-runtime-fixes`, branch `codex/harness/runtime-fixes`, committed input `619b388a56eba07f63aad80310daa889b1583a8a`. This unit made no commit, push, merge, deployment, paid model call, live MCP change, or global setting change.

## Changes

- `src/manager.mjs`: reject rollover while any alias sharing its session or worktree is queued/active; recheck old-session seals when dispatching queued raw continuations; repair missing seals on idempotent rollover retry and before cleanup removes a rollover child. Preserve the existing workflow-reference cleanup checks. An unresolved steering delivery blocks instruction-carrying continuations, while code-only independent review remains available. Approving attestations now require the review job's own fresh acceptance to be `accepted` or `not_requested`; attestation history fails closed at 32 entries instead of dropping old request IDs.
- `src/session-transition.mjs`: carry a bounded exact authoritative instruction ledger through normal followups, acknowledged text steering and fresh handoffs. Preserve the existing 100,000-character public task input limit; reject missing or oversized mandatory entries at the appropriate continuation boundary.
- `src/worker.mjs`: infer idle/repeated-failure stops only while the Pi prompt is active, so a slow valid verifier is not cancelled. Persisted policy-stop records remain effective through Pi settlement and finalization. The worker durably records accepted steering text before publishing its acknowledgement; uncertain delivery retains a private processing record and fails closed on later instruction-carrying continuation. Manager does not concurrently write the worker's job record.
- `test/harness-runtime-manager.test.mjs`, `test/harness-runtime-session.test.mjs`, `test/harness-runtime-worker.test.mjs`, `test/fixtures/harness-runtime-fake-pi.mjs`: focused regressions, including A → B/preserve C → rollover Continue, accepted steering → rollover, ambiguous steering, a 10,001-character ordinary task, persisted context stop, and a slow valid verifier.

## Commands and actual results

After writing the focused tests and before implementation, transferred the full source fixture to gram:

```sh
ssh gram 'mkdir -p /tmp/pi-harness-implementation-20261024/runtime-fixes/app'
tar --no-xattrs -cf - src test internal-agent scripts docs examples package.json package-lock.json | ssh gram 'tar -xf - -C /tmp/pi-harness-implementation-20261024/runtime-fixes/app'
```

All tests ran remotely with image `pi-harness-implementation:test-20261024`, `--network none`, UID `1001:1001`, and separate mounts for `/app/src`, `/app/test`, `/app/internal-agent`, `/app/scripts`, `/app/docs`, `/app/examples`, and `/app/package.json`, preserving image-packaged `/app/node_modules`. The focused RED command was:

```sh
ssh gram 'docker run --rm --network none --user 1001:1001 -v /tmp/pi-harness-implementation-20261024/runtime-fixes/app/src:/app/src -v /tmp/pi-harness-implementation-20261024/runtime-fixes/app/test:/app/test -v /tmp/pi-harness-implementation-20261024/runtime-fixes/app/internal-agent:/app/internal-agent -v /tmp/pi-harness-implementation-20261024/runtime-fixes/app/scripts:/app/scripts -v /tmp/pi-harness-implementation-20261024/runtime-fixes/app/docs:/app/docs -v /tmp/pi-harness-implementation-20261024/runtime-fixes/app/examples:/app/examples -v /tmp/pi-harness-implementation-20261024/runtime-fixes/app/package.json:/app/package.json -w /app pi-harness-implementation:test-20261024 node --test test/harness-runtime-session.test.mjs test/harness-runtime-manager.test.mjs test/harness-runtime-worker.test.mjs'
```

RED: 6 passed, 5 failed for missing queued-alias rejection, seal repair, reviewer acceptance gate, authoritative ledger, and a slow verifier cancelled by idle timeout. After implementation and resync, the same command passed 11/11. The integrated ordinary-followup ledger test was added after that initial RED and passed in a subsequent focused manager/session run (11/11), so it does not claim its own pre-implementation RED. That subsequent command was the same Docker invocation with `node --test test/harness-runtime-manager.test.mjs test/harness-runtime-session.test.mjs`.

For the steering addition, an initial test fixture typo caused a setup failure and was fixed before evaluating behavior. The corrected RED run of `node --test --test-name-pattern="accepted steering text" test/harness-runtime-worker.test.mjs` failed because the successful steering text was missing from the ledger. The manager ambiguity test also failed because rollover admitted an unresolved processing record. After the fix, the final combined command above passed 15/15. The persisted context-stop and code-only-review assertions were added after implementation and therefore do not claim a separate RED.

No full suite was rerun in this unit. The parent owns committed integration and final broader regression. The exact live ledger is limited to 32 instructions and 256,000 serialized bytes; the fresh handoff is tighter (10,000 bytes per instruction, 20,000 bytes serialized) and refuses rollover if mandatory context will not fit. Steering images are not represented by this text ledger and are not claimed to survive rollover. The 32-entry attestation capacity also fails closed, requiring an explicit future retention design if more decisions are needed for one source.
