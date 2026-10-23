# Corporate LLM custom headers — unit report — 2026-10-23

Worktree: this task's bridge-assigned worktree, branch `codex/claude/49ba8a85-6389-4b4b-848a-e3e612f83c59`. Started from committed plan base `3e1abc1791b38cbe0309922add30373f32fb23df` (`docs/corporate-headers-plan.md`). No commit, merge, push, branch change or live MCP setting change was made by this unit; the parent reviews and commits.

## Files owned and changed

- `src/headers.mjs` (new): non-executing Pi 1.4.0-compatible template parser/validator, shared by manager and worker.
- `src/manager.mjs`: preflight header validation before any fresh job/worktree allocation, on every submission (including followups); `public()`/`result()`/`status()` now widen redaction to header-referenced environment values; `seedAgent()`'s source-resolution behavior is unchanged.
- `src/worker.mjs`: revalidates owned header configuration against the worker's own forwarded environment immediately before spawning Pi; `collectSecrets` now uses the shared template scanner and masks any header-sourced value regardless of length.
- `src/sanitize.mjs`: redaction now also covers each secret's JSON-escaped form and applies longest-first so a short secret cannot partially consume (and leave a fragment of) a longer overlapping one.
- `src/server.mjs`: `pi_list` awaits the now-async `Manager.public()`.
- `test/headers.test.mjs` (new), `test/real-pi-headers.test.mjs` (new).
- `examples/models.example.json`, `examples/config.example.json`: corporate `headers` example (provider- and model-level) with an `envAllowlist` entry per referenced name.
- `docs/corporate-setup.md`: new "사내 전용 HTTP 헤더 (`headers`)" section (Korean, matching the file's existing language).
- `README.md`: one-sentence pointer to the headers example/behavior.
- `docs/corporate-headers-report.md` (this file).

Not touched: `docs/corporate-headers-plan.md`, `handoff.md`, `package.json`, `package-lock.json`.

## Contract recap (docs/corporate-headers-plan.md)

Reuse Pi 1.4.0 `models.json` provider/model `headers` and `envAllowlist`. Validate header name/value/type, CR/LF or control bytes, command-bearing values, and missing/empty referenced environment variables in the forwarded child environment, before any job or request; honor Pi's `$NAME`/`${NAME}`/embedded/escaped semantics; revalidate on every submission; never echo secret values in errors; preserve reference strings (not materialized credentials); keep OAuth/regular provider behavior; redact arbitrary header names in public status/result/log/error/patch paths.

## Design

`src/headers.mjs` exports a pure, non-executing scanner (`scanTemplate`) matching the installed Pi 1.4.0 grammar: `$$` → literal `$`, `$!` → literal `!`, `$NAME`/`${NAME}` reference `[A-Za-z_][A-Za-z0-9_]*`, an invalid/unclosed `${` is left literal, and a resolved value is never re-scanned (no recursive expansion). `validateProviderHeaders({ modelsConfig, authConfig, provider, model, childEnv })` validates header-map **syntax** (name token characters, string type, no CR/LF/control bytes, no `!`-prefixed command value) across **every** provider and model in the file, but only enforces **missing/empty environment** for the **selected** provider's own headers and the **selected** model's own headers — so an unused provider's absent credential never blocks an unrelated job, and a model overlay overwriting a provider header name does not exempt that provider header's own reference from being checked.

`auth.json` credential precedence: an `api_key` credential's `env` map overlays the forwarded child environment for **both** provider- and model-level header references; an `oauth` credential's `env` map overlays **provider-level** references only — model-level header references always fall back to the forwarded child environment. An empty credential-env value falls back to the child environment rather than being treated as present. No credential command/login/refresh is invoked; this module only reads already-decoded JSON.

`Manager.start()` calls `validateHeaders(provider, model)` immediately after the provider/model are resolved and the `request_id` idempotent-return check (an idempotent hit returns the existing job without a fresh allocation and is not re-validated), and before the concurrency check, `id`/`dir` allocation, `git worktree add`, or `job.json` write. `worker.mjs` repeats the same check against its own `process.env` immediately before spawning Pi, reading the owned (seeded) `models.json`/`auth.json`. Every thrown message names the header and/or the referenced environment variable, never a resolved value.

Redaction: `worker.mjs`'s `collectSecrets` now treats any string reached through a `headers` map as secret at any length (including 1–5 characters), since an arbitrary custom header name cannot be recognized by the generic `token|key|secret|...` name pattern; values reached by that generic name pattern elsewhere keep the existing 6-character floor. `Manager.public()`/`result()`/`status()` pass the current header-referenced environment values (for every provider/model in the owned-or-source `models.json`) as `extraSecrets` into `sanitize()`, so arbitrarily named header secrets are masked even for a freshly constructed `Manager` that never ran a worker. `sanitize()` also redacts each secret's `JSON.stringify`-escaped form and sorts candidates longest-first before the sequential `split/join`, so a short secret can no longer partially consume a longer overlapping one.

## TDD and verification

All installs and tests ran on `gram` per the plan's unit instructions, in task-owned `/tmp/pi-mcp-headers-20261023/`, Docker `node:24.22.0-bookworm`, `--network none`, no published ports.

- RED (parent-run, reported back to this unit): `node --test test/headers.test.mjs test/real-pi-headers.test.mjs` → **21 tests, 5 passed, 16 failed**. The 5 pre-implementation passes were the two escape-grammar guard tests (`$$`/`$!` not misread as references), the fully-valid-headers acceptance test, and the two `real-pi-headers.test.mjs` baseline round-trip tests (Pi already forwards configured `headers` without any pi-mcp change). The 16 failures were exactly the "must reject" cases: header name/value/type/CRLF/control-byte/command-bearing syntax, missing/empty `$NAME`/`${NAME}`/embedded references, the model-level (`modelOverrides`) equivalents, the no-secret-in-error-message case, and the revalidate-on-later-submission case — confirmed as absent-behavior failures, not import/setup failures.
- Additional tests written for this GREEN pass (not yet executed by this unit; this unit does not run tests locally per its constraints): unused-provider-with-missing-env must not block; a syntactically valid template whose **resolved** value contains CRLF is still rejected; no recursive re-parsing of a resolved value; `api_key` vs `oauth` `auth.json` credential-env scoping (provider+model vs. provider-only); and a 3-character header-sourced secret redacted from public/private result despite the generic 6-character floor.
- GREEN command for the parent to run remotely: `node --test test/headers.test.mjs test/real-pi-headers.test.mjs`, followed by the full `npm test` regression suite (`test/*.test.mjs`) to confirm no regression in `manager.test.mjs`, `lifecycle.test.mjs`, `config.test.mjs`, `core.test.mjs`, `mcp.test.mjs`, `real-pi.test.mjs`, `proxy-pi.test.mjs`, `real-policy.test.mjs`, and the `regression-*` suites. This unit reasoned through each of those files' `models.json`/`auth.json` usage (none configure a `headers` field except the two lifecycle.test.mjs cases, which keep a present/non-empty referenced value and are unaffected) and through every call site of the now-async `Manager.public()` (`manager.mjs` ×3, `server.mjs` ×1, all updated to `await`), but has not executed any of this locally — this phase explicitly disallows local npm/install/build/test/services, so these results are reasoned, not measured, and the parent's remote run is the actual verification.

## Unresolved assumptions requiring confirmation against the installed Pi 1.4.0 package

- The exact `$$`/`$!` escape semantics (`$$` → literal `$`, `$!` → literal `!`) were supplied by the parent as verified against the installed `@earendil-works/pi-coding-agent@1.4.0` parser; this unit could not independently confirm them (no local network/npm access in this phase) and encoded them as stated.
- Per-model `headers` ("modelOverrides") as a sibling of `id`/`name`/`contextWindow`/`maxTokens` inside `models[]`, and the `auth.json` shape `{ providerId: { type: 'api_key'|'oauth', key?, env? } }` / `{ ..., access, refresh, expires, env? }`, follow the parent's stated verification; this unit did not have the installed package available to cross-check the schema directly.
- `authHeader: false` is **not** claimed anywhere in this change (docs or code) to suppress Pi's SDK-generated `Authorization` header; `test/real-pi-headers.test.mjs` only proves that an explicitly configured custom `Authorization` header value is what the mock gateway observed. Whether `authHeader: false` additionally changes SDK behavior remains unverified and undocumented.
- The round-trip tests in `test/real-pi-headers.test.mjs` require the installed Pi bundle (`node_modules/@earendil-works/pi-coding-agent`) and therefore only run where that is present (gram), matching the existing `test/real-pi.test.mjs` pattern; they were authored but not executed by this unit.
- Real corporate LLM gateway endpoint format, exact header names, and acceptance remain unverified outside this conversation, per the plan.
