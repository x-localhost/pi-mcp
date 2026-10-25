# LLM response resilience and source review plan — 2026-10-25

Request: the corporate LLM API sometimes returns empty or malformed responses under load. Add mitigation, and review the whole source and fix real defects.

Base: clean `main` `0fd464f`. Integration branch `claude/llm-resilience/integration`, worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/llm-resilience`.

## Observed gaps (Pi 1.4.0 source, read on gram)

- Pi auto-retries only `stopReason: "error"` whose message matches its transient pattern (429/5xx, timeout, "terminated", "ended without", ...). Defaults: 3 retries, 2 s base, exponential.
- A 200 response whose stream has `finish_reason: "stop"` but no text and no tool calls becomes an assistant message with empty content and `stopReason: "stop"`. Pi does not retry; the agent run ends.
- `worker.mjs` accumulates text across all assistant messages, so an empty *final* message after earlier text is accepted as `completed`. A run whose only message is empty fails with "Pi settled without an assistant result" and no recovery.
- Malformed SSE JSON surfaces as an error message (parse error) that Pi's pattern does not retry.
- `internal-agent/gateway.mjs` pipes the first upstream reply straight through; no upstream retry, no validation of empty or malformed bodies.

## Design

Two independent layers, so either profile benefits:

1. **Worker recovery (host and internal profiles)** — after Pi settles, classify the final assistant message. Recoverable anomalies trigger a bounded continuation prompt in the same Pi session with backoff. Completion requires the *last* assistant message to be healthy.
2. **Gateway retry (internal profile)** — retry the upstream call transparently while nothing has been forwarded to Pi; validate the stream until the first meaningful chunk; after commit, cut the connection on malformed data so Pi's own retry engages; when retries are exhausted answer `503` (Pi retries 503).

Pi's own settings are not modified (shared owned agent dir); the worker only sends `set_auto_retry {enabled:true}` to make Pi's built-in retry explicit.

## Contracts

### Unit A — worker recovery (`claude/llm-resilience/worker`)

Owner files: `src/worker.mjs`, `src/config.mjs`, `src/manager.mjs` (runtime.json plumbing only), `src/capabilities.mjs`, new `src/provider-recovery.mjs`, new tests `test/provider-recovery.test.mjs` (+ fixture changes under `test/fixtures/` that do not break existing tests), `examples/config.example.json` (optional section), new `docs/provider-resilience.md`.

- Config section `providerRecovery` (optional, validated fail-closed, unknown keys rejected): `maxAttempts` int 0..5 default 2; `baseDelayMs` int 0..120000 default 5000; `maxDelayMs` int 0..600000 default 60000, must be ≥ `baseDelayMs`. `maxAttempts: 0` disables recovery. Passed to the worker via `runtime.json` key `providerRecovery`; exposed in `pi_capabilities` as `providerRecovery: { version: 1, ...values }`.
- `src/provider-recovery.mjs` exports pure `classifyFinalMessage(message)` returning `{ healthy: true }` or `{ healthy: false, recoverable: boolean, reason }` with `reason` one of `empty_response`, `truncated_empty`, `malformed_response`, `provider_unavailable`, `provider_error`; and `recoveryDelayMs(policy, attempt)` (exponential from `baseDelayMs`, capped at `maxDelayMs`).
  - healthy: `stopReason` `stop`/`end_turn` and visible text (after trimming whitespace, control chars and U+FFFD) is non-empty.
  - `empty_response` (recoverable): `stop`/`end_turn`/`toolUse` with no visible text and no tool calls.
  - `truncated_empty` (recoverable): `length` with no visible text and no tool calls. `length` with text is not healthy and not recoverable (`provider_error`), keeping current failure semantics.
  - `malformed_response` (recoverable): `error` whose message indicates a parse/protocol failure (e.g. JSON parse, "Could not parse", "Unexpected token", "Unexpected end of JSON", "invalid response", "Stream ended without finish_reason", "empty response").
  - `provider_unavailable` (recoverable): `error` matching transient availability (429, 5xx, overloaded, timeout, terminated, connection reset) — reached only after Pi's own retries ran out.
  - `provider_error` (not recoverable): everything else, including auth (401/403), quota/billing, content filter, context overflow, `aborted`.
- Worker loop: after `agent_settled` with no stop request, classify the last assistant message of that run. If recoverable and attempts remain, wait `recoveryDelayMs` (abortable by cancel/timeout/stop; never past the job deadline), then send a new RPC `prompt` in the same session with a fixed English continuation message (states the previous response was empty/malformed, asks to continue from the current worktree state without repeating finished steps and end with a short summary). Await a fresh `agent_settled`. Turn limit, timeout, budget, cancel and steering keep working across attempts.
- Success requires the final run's last assistant message to be `healthy`. Exhaustion fails the job with error `Provider returned <reason> (recovery exhausted after N attempts)`. Non-recoverable keeps today's error text.
- Job record: `job.providerRecovery = { attempts, maxAttempts, history: [{ attempt, reason, at }] }` (bounded ≤ 10 entries, no provider text). Event `{ type: 'provider_recovery', attempt, reason, delayMs }` via `emitEvent`. Public `pi_status`/`pi_result` include `providerRecovery` if manager's public projection allows; add it where execution metadata is exposed.
- `finalText` keeps accumulating; the empty-final hole is closed by the healthy-final rule.

### Unit B — gateway retry (`claude/llm-resilience/gateway`)

Owner files: `internal-agent/gateway.mjs`, `internal-agent/gateway.example.json`, `scripts/check-internal-agent.py` (accept the new key only), new tests `test/internal-gateway-resilience.test.mjs`, a short section in `docs/internal-agent.md`.

- Gateway config key `retry` (optional, exact keys): `maxAttempts` int 1..5 default 3 (total upstream attempts); `baseDelayMs` int 0..10000 default 500; `maxDelayMs` int 0..30000 default 8000, ≥ `baseDelayMs`. Delay is exponential with full jitter, `Retry-After` seconds honoured but capped at `maxDelayMs`.
- Retry **only before any byte is forwarded to the client**, for: connect/TLS-handshake-free network errors and timeouts before response headers; upstream status 429, 500, 502, 503, 504; unexpected content-type; non-stream JSON that is invalid, has no `choices`, or whose first choice has neither non-empty content nor tool calls; streamed responses that end, send `[DONE]`, or send an invalid JSON `data:` line before the first meaningful chunk (a parsed chunk whose first choice delta has non-empty `content`, `reasoning_content`/`reasoning`, or `tool_calls`). Never retry 400/401/403/404/413 or TLS verification failures.
- Pre-commit buffering is bounded (≤ 1 MiB of SSE bytes, otherwise commit as-is). After commit keep forwarding, but on an invalid JSON `data:` line or an upstream end without `[DONE]`/`finish_reason`, destroy the client socket instead of forwarding garbage (Pi treats the cut as retryable "terminated").
- Each upstream attempt consumes a `requestsPerMinute` slot; if none is left, stop retrying. All attempts together stay within the existing 120 s total and 10 s connect limits; client disconnect cancels pending retries.
- Exhausted retries: respond `503` text `Upstream unavailable: empty or malformed response\n` (or `Upstream unavailable\n` for status/network failures) with the existing category scheme plus new category `malformed`. Audit entries gain `attempts` (int).

### Unit C — source review fixes

Independent read-only review (`fable-reviewer`) of `src/`, `internal-agent/`, `scripts/`, `evals/` on `0fd464f`. Lead verifies each finding against code, then assigns confirmed fixes to a writer on `claude/llm-resilience/fixes` with RED/GREEN tests. Findings in files owned by Unit A or B are routed to that unit (or applied after it integrates) to avoid overlap.

## Resources and verification

- Codex bridge was at its 2-job cap from other sessions at start (`activeJobs: 2`), so Astra design consult and Sol could not run; native Sonnet implementers and the native Fable reviewer are used. Astra final review is attempted again before merge and reported if still unavailable.
- Tests on gram only, in Docker image `pi-mcp-llmres:base-20261025` (node:24.22.0-bookworm + rg/fd + locked deps) with `--network none`, via `/tmp/pi-mcp-llm-resilience-20261025/run-suite.sh <srcdir> <container-name> [test files]`. Each unit copies its worktree to its own `/tmp/pi-mcp-llm-resilience-20261025/<unit>/` and uses unique container names. gram `/home` is full, so Docker client commands that need config must set `DOCKER_CONFIG=/tmp/pi-mcp-llm-resilience-20261025/dockercfg`.
- TDD: each behaviour gets a failing test first (RED recorded), then GREEN. Unit A must include a real Pi 1.4.0 test against a local mock HTTPS/HTTP gateway returning an empty completion first and a valid one second.
- Integration: A, B, then C serially into the integration branch; full suite on the integrated commit; independent review; ff-merge to clean local `main`. No push, publish, deploy or paid model calls.

## Results — 2026-10-25

All runs on gram, image `pi-mcp-llmres:base-20261025`, `--network none`.

| Step | Commit | Evidence |
| --- | --- | --- |
| Baseline `main` | `0fd464f` | full suite 384/384 |
| Unit A worker recovery (Sonnet) + lead fix for tool-call-only final replies | `4723fda` | RED 40/50, GREEN 50/50 incl. real Pi 1.4.0 empty-then-valid mock; full 434/434 |
| Unit C1 review fixes (Sonnet) + lead fixes: launch identity in `worker-identity.json` (no stale job.json rewrite), no-op stdin error listener after close | `c82ea57` | RED 0/12, GREEN 12/12; full 396/396; lead rerun 43/43 |
| Unit C2 worker review fixes (Sonnet) + lead fix: stop before Pi identity no longer resolves "ambiguous" | `1560c0a` | RED 2 failing, GREEN 3/3 x3; full 437/437; lead rerun 73/73 |
| Unit B gateway retry (Sonnet), on by default after lead review | `20d4b72`, merge `2ecbfae` | resilience 11/11, gateway suites 22/22; integrated full 460/460 |
| Final independent review (native Fable reviewer) | `2ecbfae` | approve, no blocking defects; 6 non-blocking notes |
| Follow-ups for those notes (Sonnet) | merge `58e5f6a` | 7 new tests RED then GREEN; full 467/467 on the identical tree |

Source review findings fixed: dispatcher dying on a busy submit lock; RPC stdin EPIPE crash; quarantine dead-ends for a worker or Pi that died before identity capture; stale terminal-status list in artifact export; retention scan bound breaking admission/health; abrupt Pi kill on stop.

Not done: Codex bridge stayed at its 2-job cap from other sessions, so no Astra design consult or review ran; the native Fable reviewer substituted for the independent review. Real corporate LLM behaviour under load is not measured; only mocks were used.
