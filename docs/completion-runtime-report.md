# Completion runtime unit report — 2026-10-24

Worktree: `/Users/leebw/workspace/claude/pi-mcp-worktrees/completion-runtime`, branch `codex/completion/runtime`. Parent supplied committed input `e170b50459b58ef3267911c25c562a2eadf1d0b1` and later committed dependencies `d409f6d`, `9d26349`, `a129666` in this checkout. Parent owns review and commits. This report covers the uncommitted runtime unit only.

## Delivered behavior

- Bounded persisted FIFO queue, frozen source commit/security policy/model-material identity, durable request IDs, queued expiry/cancel and a detached kernel-locked dispatcher that resumes on server startup and cannot lose an enqueue at idle handoff. The dispatcher retains only configured, already filtered named proxy-selector values. Queued admission rechecks roots and storage; owned OAuth credentials may refresh while model identity stays pinned.
- Linux boot/PID-namespace/start identity and process-group proof for Pi, worker and verifiers; quarantined recovery with inspect-first evidence; reference-safe dry-run retention cleanup including shared sessions and preserved request tombstones. Bounded soft storage admission and health preview.
- Administrator-selected exact verifier commands with bounded output/time and distinct execution/verification results. Terminal status waits for process proof, verification, source capture, report attachment and event completion. Cancellation and job deadline remain active through verification.
- Bounded cursor events without raw model text deltas; worker-acknowledged steering with no replay on ACK loss; strict inline image validation; immutable private session/code forks; approved MCP tool readiness and Pi CLI tool ceiling wiring.
- Token/cost budgets based on observed usage and session-stat reconciliation, including total-only and textless assistant/tool responses, explicit `budget_limit`/`budget_unavailable`; exact paged public artifact transport, output previews, structure-aware JSON report redaction, sanitizer-preserving hashes/IDs and shared-lock export.

## TDD and executed checks

All executable checks ran on `gram` using `pi-mcp-completion:base-20261024`, `--network none`, remote disposable directory `/tmp/pi-mcp-completion-20261024/runtime`; source was synced by `rsync -a --exclude node_modules src/ .../src/` and `rsync -a test/ .../test/`. No local test suite, install, service or paid endpoint was used.

- RED: initial focused `node --test test/completion-runtime.test.mjs` failed 3 expected assertions for rejected queue config, cross-submission queueing and missing event append; GREEN: 4/4 after implementation.
- RED: focused retention/storage/recovery/RPC command below passed 3/5, failing default retention preview and storage admission as intended; GREEN: 5/5 after `opendir` bound and explicit dry-run retention selection.
- Focused verification/final-capture and budget command passed 4/4, including injected final snapshot incompleteness/digest change, failed/cancelled verifier behavior, public report equality and invalid negative usage.
- Real released Pi 1.4.0 local mock test passed 1/1: original job → followup → immutable fork with distinct worktree/session and original code, plus steering RPC acknowledgement. The test container had `--network none` and made no paid model call.
- MCP stdio artifact/base64 hash roundtrip and reconnect test passed 1/1; a secret string that occurs only in encoded output did not mutate public byte/hash fields.
- Combined runtime boundary suite initially passed 88/89; the sole failure was an `ENOTEMPTY` fixture teardown race with the persistent dispatcher after all behavior assertions. Teardown now removes its config first and retries recursive removal. A packaged approved-MCP fixture full suite then passed 247/247; after terminal watchdog/cancel fixes, the same full suite passed **248/248** in 163 seconds.
- After independent review, focused queue/proxy/auth/storage, `/proc` scan, usage, artifact and short-secret tests passed **6/7** on first run; the one failure was an expected placeholder-case mismatch in the new assertion (`[redacted]`, not `[REDACTED]`). The MCP short-secret and separate encoded-only secret roundtrips then passed **2/2**. The final packaged-fixture full suite passed **253/253** in **175.4 seconds**, zero failures, on gram. Its output is `/tmp/pi-mcp-completion-20261024/runtime/full-suite-final-six.log`.
- After that full suite, parent review identified a bounded state-scan race. RED: the focused disappearance test failed with `ENOENT` from an entry removed between directory enumeration and `opendir`. GREEN: the disappearance test, existing scan bound test and queued storage admission test passed **3/3** after skipping only proven-vanished nested entries. An injected `EACCES` remains a failure. The parent will run the final full suite from committed integration with this last narrow change.

Focused command (the selected test name pattern was changed per feature):

```sh
ssh gram 'docker run --rm --network none --user 0:0 -v /tmp/pi-mcp-completion-20261024/runtime/src:/app/src:ro -v /tmp/pi-mcp-completion-20261024/runtime/test:/app/test:rw -w /app pi-mcp-completion:base-20261024 timeout 60s node --test --test-name-pattern="queued work expires|default cleanup previews|storage scan stops|recoverJob inspects|oversized RPC" test/completion-runtime.test.mjs test/regression-rpc.test.mjs'
```

Combined command:

```sh
ssh gram 'docker run --rm --network none --user 0:0 -v /tmp/pi-mcp-completion-20261024/runtime/src:/app/src:ro -v /tmp/pi-mcp-completion-20261024/runtime/test:/app/test:rw -w /app pi-mcp-completion:base-20261024 timeout 120s node --test test/completion-runtime.test.mjs test/completion-real-pi.test.mjs test/lifecycle.test.mjs test/mcp.test.mjs test/manager.test.mjs test/regression-process.test.mjs test/regression-rpc.test.mjs test/headers.test.mjs'
```

Full packaged-fixture command (stdout/stderr redirected to the log above, then exit status and the last 45 lines checked):

```sh
ssh gram 'docker run --rm --network none --user 0:0 -v /tmp/pi-mcp-completion-20261024/runtime/src:/app/src:ro -v /tmp/pi-mcp-completion-20261024/runtime/test:/app/test:rw -v /tmp/pi-mcp-completion-20261024/runtime/internal-agent:/app/internal-agent:ro -v /tmp/pi-mcp-completion-20261024/runtime/scripts:/app/scripts:ro -v /tmp/pi-mcp-completion-20261024/runtime/docs:/app/docs:ro -w /app pi-mcp-completion:base-20261024 sh -c "mkdir -p /app/approved-mcp && cp /app/test/fixtures/approved-mcp-stdio.mjs /app/approved-mcp/mock.mjs && ln -s /app/approved-mcp /app/approved-mcp/link && chmod 0555 /app/approved-mcp /app/approved-mcp/mock.mjs && timeout 300s node --test --test-concurrency=1 test/*.test.mjs"'
```

Final focused state-scan command:

```sh
ssh gram 'docker run --rm --network none --user 0:0 -v /tmp/pi-mcp-completion-20261024/runtime/src:/app/src:ro -v /tmp/pi-mcp-completion-20261024/runtime/test:/app/test:rw -v /tmp/pi-mcp-completion-20261024/runtime/internal-agent:/app/internal-agent:ro -w /app pi-mcp-completion:base-20261024 node --test --test-name-pattern="storage scan tolerates only entries proven|storage scan stops during enumeration|queued admission rechecks storage" test/completion-runtime.test.mjs'
```

## Scope and limits

Runtime files: `src/manager.mjs`, `src/worker.mjs`, `src/server.mjs`, `src/rpc.mjs`, new `src/{dispatcher,events,images,ownership,storage,verification,verifier-runner}.mjs`; narrow integration fix `src/artifacts.mjs`; `internal-agent/export-artifacts.mjs`. Tests: new `test/completion-runtime.test.mjs`, `test/completion-real-pi.test.mjs`, updated `test/fixtures/fake-pi.mjs`, `test/{headers,lifecycle,mcp,proxy-pi,real-pi-headers,real-pi,real-policy,regression-real-tools,regression-rpc}.test.mjs`. Configuration `src/config.mjs` was separately reviewed and committed by parent as `9d26349`. New guide: `docs/completion-runtime.md`.

The local mock validates released Pi CLI/session/steering behavior, not corporate endpoint acceptance. This runtime requires Linux `/proc` and `/usr/bin/flock`; old processes must stop before upgrade to the new lock protocol. Queue identity pins model and security configuration but allows refreshed owned OAuth/auth content after current credentials are revalidated at admission. Per-user OS isolation and actual corporate authentication remain outside gaps 3–8. Admission is a soft storage bound; budget stops follow observed usage and can overshoot in flight. The parent will run an independent full isolated-profile test and final review before integration.
