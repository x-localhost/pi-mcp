# Harness observation and workflow corrections — 2026-10-24

Worktree: `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness-observation-fixes`; branch `codex/harness/observation-fixes`; committed input `86a405fc38ab3c3bece107b91131eff5aa82b239`. The implementer left all changes uncommitted for parent review. No paid or company model endpoint was called.

## Changed files

- `src/context-policy.mjs`: every user instruction is mandatory in native/provider context reduction; optional tool history is removed only in complete groups.
- `src/policy-extension.mjs`, `src/observation.mjs`, `src/worker.mjs`, `internal-agent/gateway.mjs`: logical Pi call correlation, bounded assistant stream progress, truthful compaction/progress handling, and gateway ingress IDs. The gateway records a bounded arrival-time `observedRepeatOfCall` flag, so overlapping requests remain correctly associated even if responses finish out of order. Public observation calls the stable Pi header ID `providerCallId`.
- `src/session-transition.mjs`, `src/manager.mjs`, `src/worker.mjs`: preserve the 100,000-character ordinary prompt contract for Unicode, bound the exact continuation ledger, reject fresh rollover when initial/accepted steering images or legacy unknown image context cannot be carried, and publish per-response usage availability evidence.
- `src/workflow.mjs`, `src/manager.mjs`: reconcile children against Manager's exact request hash, including a followup automatically admitted as a rollover; recheck source code, contract, acceptance, and identity under the same submit lock as admission; recheck release acceptance under the submit lock; require a review child's own acceptance; count cancelled terminal child usage exactly once; reject budget dimensions with any missing response measurement.
- `test/harness-tools.test.mjs`, `test/harness-context.test.mjs`, `test/harness-tools-gateway.test.mjs`, `test/harness-runtime-manager.test.mjs`, `test/harness-runtime-worker.test.mjs`, `test/harness-workflow.test.mjs`, `test/regression-process.test.mjs`, `test/fixtures/harness-runtime-fake-pi.mjs`: focused regressions. The process test now creates an exact valid raw-session checkpoint before its two-process followup race.
- `docs/harness-runtime.md`, `docs/harness-workflow.md`: corrected limits, trace semantics, availability, and atomic workflow behavior.

## Remote commands and results

The source was synced with:

```sh
tar --no-xattrs -cf - src test internal-agent scripts docs examples package.json package-lock.json | ssh gram 'tar -xf - -C /tmp/pi-harness-implementation-20261024/coordination-fixes/app'
```

All tests ran on gram in pinned image `pi-harness-implementation:test-20261024`, `--network none`, UID `1001:1001`, with separate read/write task mounts for `/app/src`, `/app/test`, `/app/internal-agent`, `/app/scripts`, `/app/docs`, `/app/examples`, and `/app/package.json`; `/app/node_modules` remained image-packaged. The final focused command was:

```sh
ssh gram 'docker run --rm --network none --user 1001:1001 -v /tmp/pi-harness-implementation-20261024/coordination-fixes/app/src:/app/src -v /tmp/pi-harness-implementation-20261024/coordination-fixes/app/test:/app/test -v /tmp/pi-harness-implementation-20261024/coordination-fixes/app/internal-agent:/app/internal-agent -v /tmp/pi-harness-implementation-20261024/coordination-fixes/app/scripts:/app/scripts -v /tmp/pi-harness-implementation-20261024/coordination-fixes/app/docs:/app/docs -v /tmp/pi-harness-implementation-20261024/coordination-fixes/app/examples:/app/examples -v /tmp/pi-harness-implementation-20261024/coordination-fixes/app/package.json:/app/package.json -w /app pi-harness-implementation:test-20261024 node --test test/harness-runtime-session.test.mjs test/harness-runtime-manager.test.mjs test/harness-runtime-worker.test.mjs test/harness-context.test.mjs test/harness-tools.test.mjs test/harness-tools-gateway.test.mjs test/harness-workflow.test.mjs test/regression-process.test.mjs'
```

Observed final result: **61 tests passed, 0 failed**, 25.9 seconds. It includes actual pinned Pi context reduction and 429/transport retry tests against local loopback mocks, an active streamed response, concurrent gateway ingress, real Manager workflow recovery and revocation, an oversized raw session, slow verifier, and two independent process submissions. Parent owns the full-suite and fixed internal-profile acceptance after commit.

Focused RED observations before corresponding changes:

- The context reduction/compaction tests failed because a middle user instruction was dropped and compaction starts counted as progress; the corrected focused tests passed.
- The gateway metadata test initially failed with missing `providerCallId`. Its overlapping-request test then failed because completion-order audit scanning marked the wrong request as repeated. After arrival-time tracking, `node --test test/harness-tools-gateway.test.mjs` passed 1/1.
- `node --test --test-name-pattern="partial positive aggregate" test/harness-workflow.test.mjs` failed: a positive aggregate advanced despite one response being unmeasured. After per-response availability tracking, the final workflow suite passed 27/27.
- The real Pi test first expected a fresh header ID for each SDK retry and failed for both 429 and socket-drop. Inspection of pinned Pi showed the public `before_provider_headers` callback runs before the internal provider retry loop. The corrected test asserts the observed behavior and no invented `provider_retry` event; its 429 and transport cases passed 3/3 including the parent test.
- `node --test test/regression-process.test.mjs` initially passed 5/6 after adding a valid checkpoint because the loser error text was `Continuation source is not latest worktree tip`; the assertion was made precise and the final combined run passed all six process tests.
- A final worker/workflow regression after the 61-test run found that an invalid response with positive total tokens/cost but negative input/cost components could be discarded from the aggregate while leaving `usageAvailability` true. With no per-job budgets configured, the test then sent a valid positive response and required the workflow-only token/cost budget to block. The exact focused command was the same gram Docker invocation above with `node --test --test-name-pattern="oversized raw history" test/harness-runtime-worker.test.mjs`: RED 0/1 (actual `usageAvailability.totalTokens` true, expected false), then GREEN 1/1 after `src/worker.mjs` marked both dimensions unavailable before discarding the invalid response. The final 61-test suite was not repeated for this last narrowly scoped change.

The earlier manager image-continuity and Unicode tests were added during this unit after related implementation changes; they are passing regressions, not claimed as independent pre-implementation RED evidence.

## Limits and handoff

The Pi extension API sees logical provider calls, not each inner SDK 429/transport retry. The private wire header `x-pi-attempt-id` is retained for compatibility but carries a provider-call correlation ID. Gateway `requestId` is unique per observed ingress, not proof of an upstream model call or of a transport attempt that never arrived. `observedRepeatOfCall` means only that a matching call was seen in the gateway's bounded 256-key memory; absence after eviction/restart is unknown, and a repeat is not necessarily an SDK retry.

The ordinary authoritative text ledger permits 32 entries and 1,000,000 serialized bytes. Fresh handoff remains limited to 10,000 bytes per instruction and 20,000 bytes total. Image context is detected but not serialized into fresh handoff; rollover refuses rather than losing it. Unknown legacy image context also refuses. Review remains code-only. Attestation history remains capped at 32 durable receipts and fails closed at capacity.
