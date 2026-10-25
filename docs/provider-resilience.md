# Provider response resilience (worker recovery)

Some corporate LLM gateways occasionally return a `200` response whose stream
ends with `finish_reason: "stop"` but no text and no tool calls, or a stream
that is cut short or carries malformed JSON. Pi's own retry
(`set_auto_retry`) only covers `stopReason: "error"` messages whose text
matches its transient-failure pattern (429/5xx, timeout, "terminated",
"ended without", …); it does not retry an empty-but-successful reply, and
`worker.mjs` previously accumulated text across all assistant messages in a
run, so an empty *final* message after earlier text was silently accepted as
`completed`.

This worker now classifies the final assistant message of each Pi run right
after `agent_settled`. A healthy final message still requires a non-empty
visible reply with stop reason `stop`/`end_turn`. A recoverable anomaly
(empty response, truncated-empty response, or a malformed/parse-error or
still-unavailable provider error) triggers a bounded continuation: after an
exponential backoff, the worker sends a fixed, English, same-session RPC
`prompt` asking Pi to continue from the current worktree state without
repeating already-finished steps, and to end with a short summary. Turn
limit, timeout, budget, cancellation and steering keep working across
attempts; the backoff itself is interrupted immediately if the job is
cancelled, times out, or is otherwise stopped.

## Configuration

Add an optional `providerRecovery` section to the worker configuration
(`examples/config.example.json`):

```json
"providerRecovery": {
  "maxAttempts": 2,
  "baseDelayMs": 5000,
  "maxDelayMs": 60000
}
```

- `maxAttempts` (integer, `0`-`5`, default `2`): how many continuation
  prompts the worker may send for one run. `0` disables recovery entirely —
  the first recoverable anomaly fails the job immediately instead of being
  retried, closing the gap where an empty final message after earlier text
  used to be silently accepted.
- `baseDelayMs` (integer, `0`-`120000` ms, default `5000`): delay before the
  first continuation attempt.
- `maxDelayMs` (integer, `0`-`600000` ms, default `60000`, must be `>=
  baseDelayMs`): cap on the exponential backoff (`baseDelayMs * 2^(attempt -
  1)`, capped).

The effective values are exposed read-only in `pi_capabilities` as
`providerRecovery: { version: 1, maxAttempts, baseDelayMs, maxDelayMs }`.

## Classification

`src/provider-recovery.mjs` exports a pure `classifyFinalMessage(message)`:

- **healthy** — stop reason `stop`/`end_turn` with non-empty visible text
  (after trimming whitespace, control characters, and the Unicode
  replacement character U+FFFD).
- **`empty_response`** (recoverable) — stop reason `stop`/`end_turn`/
  `toolUse` with no visible text and no tool calls.
- **`truncated_empty`** (recoverable) — stop reason `length` with no visible
  text and no tool calls. `length` *with* text is not healthy and not
  recoverable (kept as today's failure), since the output may be a cut-off,
  possibly misleading partial answer.
- **`malformed_response`** (recoverable) — stop reason `error` whose message
  indicates a parse/protocol failure (JSON parse errors, "Could not parse",
  "Unexpected token", "Unexpected end of JSON", "invalid response", "Stream
  ended without finish_reason", "empty response").
- **`provider_unavailable`** (recoverable) — stop reason `error` matching a
  transient availability failure (429/5xx, overloaded, rate limit, timeout,
  terminated, connection reset/refused). This is only reached after Pi's own
  auto-retry already exhausted its budget for that same error.
- **`provider_error`** (not recoverable) — everything else: authentication
  (401/403), quota/billing, content filter, context overflow, `aborted`, or
  an unmapped stop reason. These fail the job immediately with today's error
  text; recovery never masks a real failure.

## Job record and events

A completed or failed job carries `providerRecovery: { attempts, maxAttempts,
history }`, where `history` is at most the last 10
`{ attempt, reason, at }` entries (no raw provider text). This is exposed
through `pi_status`/`pi_result` the same way other execution metadata is.
Each attempt also emits a bounded `{ type: 'provider_recovery', attempt,
reason, delayMs }` event through `pi_events`.

Exhausting recovery fails the job with
`Provider returned <reason> (recovery exhausted after N attempts)`.

## Idle timeout across a recovery backoff

The worker records `lastPromptAt` whenever it sends a prompt (the initial
one or a continuation) and uses the *later* of that and
`lastProgressAt`/`startedAt` as the baseline for the observation
`idleTimeoutMs` check. Without this, a backoff longer than `idleTimeoutMs`
left the idle check comparing against progress evidence from before the
backoff, so the job could be stopped as `idle_timeout` the instant the
continuation prompt was sent — before Pi had any chance to answer it.

## Steering during a recovery backoff

A `pi_steer` call sent while the worker is waiting out a recovery backoff
(between a recoverable anomaly and the next continuation prompt) is accepted
and forwarded to Pi immediately, the same as a steer sent mid-run; it is not
deferred to "unknown" just because no turn is currently streaming. This was
verified against the Pi 1.4.0 source (`@earendil-works/pi-coding-agent`):
`AgentSession.steer()` always calls the low-level `Agent.steer()`, which
unconditionally enqueues onto `steeringQueue` with no precondition on an
active run; the next `prompt()` call (used by the continuation) drains that
queue via its initial steering poll and runs the queued message alongside
the continuation prompt in that turn's first LLM call. So queuing a steer
while idle during the backoff is safe and still gets delivered, instead of
sitting unseen until a steer sent during streaming would have been. The
worker only allows this specifically during the bounded backoff window
(after a recoverable anomaly, before a guaranteed next continuation prompt);
once a run has settled for good — healthy, or recovery exhausted — steering
is refused again, since no further prompt will ever drain the queue.
