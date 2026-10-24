# Harness tools and observation unit — 2026-10-24

Worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness-tools`, branch `codex/harness/tools`, base `50a55cef3c069e678e5f0b725dd3acac85a3a583`. Root, branch, base and clean initial status were verified before writing. Parent owns review and commit.

## Changed files

- `src/approved-mcp.mjs`: active-only concurrent startup, one 25-second absolute startup deadline, sibling abort/settlement/late close, 30-second exported readiness budget, independent normal call timeout.
- `src/context-policy.mjs`: strict context policy and bounded complete-group reduction; checks final serialized provider payload including tools/images, preserving system/tool state, first authoritative user request and latest request. Unsupported payload shapes pass only when already within configured byte cap.
- `src/observation.mjs`, `src/policy-extension.mjs`: bounded allowlisted metadata log, atomic activity/stop state, actual Pi 1.4 context/headers/response/tool/compaction hooks, local opaque IDs and duration fallback. Tool names are emitted only from the active configured set; raw call IDs, arguments, results, prompts and headers are ignored. Idle threshold is read by the runtime watchdog; repeated tool failure and context limits write truthful stop state and abort Pi.
- `internal-agent/gateway.mjs`, `internal-agent/profile.mjs`: validated private trace UUIDs are consumed into bounded diagnostics, rejected when malformed/duplicated, and never forwarded upstream; trace headers cannot be administrator-configured upstream headers. The fixed internal profile sets an in-process validation marker after profile and model validation.
- `test/harness-tools.test.mjs`, `test/harness-context.test.mjs`, `test/harness-tools-gateway.test.mjs`: focused regressions including released Pi mock execution.

## Runtime contract

`normalizeContext()` defaults to `{maxMessages:112,maxBytes:3500000}`; bounds are 8–120 messages and 65,536–3,800,000 bytes. `normalizeObservation()` defaults to `{maxEvents:256,maxBytes:65536,idleTimeoutMs:0,consecutiveFailureLimit:0}`; 0 disables each threshold. Bounds: events 1–1024, bytes 1,024–262,144, idle 0–3,600,000 ms, failures 0–100. `POLICY_READY_TIMEOUT_MS` is 30,000 ms. Worker policy passes optional `jobId`, `context`, `observation`, `observationFile`, `activityFile`, `stopFile`, and `traceInternalGateway`; omitted fields retain safe defaults. Trace is enabled only after fixed profile validation and worker checks the fixed corporate provider/endpoint.

Activity JSON: `{version:1,lastEventAt,lastProgressAt,consecutiveToolFailures,lastKind}`. Stop JSON: `{version:1,reason,at}`, with reason `context_limit`, `repeated_tool_failure`, or runtime-written `idle`. Observation JSONL holds constructed metadata only and is capped by both event count and byte count. Heartbeat/retry events do not update `lastProgressAt`.

## RED / GREEN and affected checks

All node:test runs were on gram, image `pi-harness-implementation:test-20261024`, with `--network none` and this unit's full source/test/internal-agent trees mounted under `/app`. Source was synchronized by `tar --no-xattrs -cf - src test internal-agent scripts docs examples package.json package-lock.json | ssh gram 'tar -xf - -C /tmp/pi-harness-implementation-20261024/tools/tree'` (diagnostic tar xattr warnings suppressed). No local suite/install/build/service ran.

- RED: `node --test /app/test/harness-tools.test.mjs` exited 1, `ERR_MODULE_NOT_FOUND` for not-yet-implemented `src/observation.mjs`.
- GREEN: same command exited 0, 5/5. The active two-server HTTP handshake completed three 6-second stages in 18.1 seconds, skipped the inactive review server, and a normal tool call still succeeded after 25 seconds. An injected failing sibling aborted, settled, and closed a late successful session.
- GREEN: `node --test /app/test/harness-context.test.mjs /app/test/harness-tools-gateway.test.mjs` exited 0, 3/3. Real Pi 1.4 stopped impossible mandatory context before any provider request; a real two-tool turn reduced coherently and its observation file omitted sentinel call IDs, arguments, results and prompt. Gateway rejected partial, malformed and duplicate trace UUIDs and sent none upstream.
- GREEN: `node --test /app/test/harness-context.test.mjs /app/test/harness-tools-gateway.test.mjs /app/test/real-approved-mcp.test.mjs /app/test/completion-gateway.test.mjs /app/test/completion-profile.test.mjs` exited 0, 15/15.
- `git diff --check` exited 0. No commits were made.

The queued fixed-profile trace path depends on the runtime unit's dispatcher marker propagation. It must be tested against the integrated tools + runtime SHA; the isolated tools base cannot exercise it. No paid or corporate endpoint was called.
