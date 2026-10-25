# Claude Code subagent support plan — 2026-10-26

Request: make Pi MCP comfortable to use as a subagent from Claude Code, adding the features that are worth having.

Base: clean `main` `3da6b20`. Integration branch `claude/claude-code-kit/integration`, worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/claude-code-kit`.

## Gaps observed (main `3da6b20`)

- Waiting costs many tool calls. `pi_status` waits at most 45 s and returns the full public job (about 50 keys). A 20-minute job therefore takes 25+ polls, and each poll puts the whole record into the caller's context. A queued job is not waited on at all, because `status()` returns immediately for `queued`. There is no way to wait on several jobs at once.
- There is no complete change set to review or apply.
  - `pi_result` gives a 24,000-character diff preview of tracked files only, and says "inspect artifacts for new files".
  - Artifacts are exact but come as base64 file snapshots. That is costly for an LLM to read and cannot go to `git apply` as it is.
  - Followups reuse the same worktree. So once a followup runs, the live worktree no longer matches the earlier job, and only the job's checkpoint does.
- Output uses pretty-printed JSON with 2-space indent, which spends tokens on whitespace in every response.
- There is no ready-made Claude Code setup: no subagent definition, no skill describing the delegate → wait → review → apply loop, and no guide to `claude mcp add` or the `.mcp.json` setup.

## Design

Two units in parallel against a fixed tool contract.

### Unit A — server tools (`claude/claude-code-kit/tools`, Sonnet implementer)

Owner files: `src/server.mjs`, `src/manager.mjs` (new methods only, plus the `untrackedNote` text), new `src/patch.mjs`, `src/capabilities.mjs`, new `test/claude-code-tools.test.mjs`, `docs/completion-runtime.md` (tool reference lines only).

**Compact output.** `out()` in `server.mjs` emits `JSON.stringify(data)` with no indentation. The structure does not change.

**`pi_wait`**

- Input:
  - `job_ids`: 1–8 unique task IDs.
  - `wait_seconds`: integer 0..WAIT_MAX, default WAIT_DEFAULT.
  - `until`: `any` or `all`, default `any`.
- Settled means a terminal status or `quarantined`. Pending means `queued`, `starting`, `running` or `finalizing`.
- How it waits:
  - Polls each job about once per second through the existing `manager.status(id, 0)`, so stale-worker recovery and queue expiry still apply.
  - Returns as soon as the `until` condition holds, the wait expires, or the MCP request's abort signal fires. An abort stops the loop and produces no further output.
  - An unknown job fails the whole call with `Job not found: <id>`.
- Progress: when the request carries `_meta.progressToken`, it sends `notifications/progress` about every 10 s, with `progress` = elapsed seconds, `total` = `wait_seconds`, and `message` = `"<settled>/<n> settled"`. When there is no token it sends nothing.
- Output: `{ until, timedOut, elapsedSeconds, settled: [ids], pending: [ids], jobs: [summary] }`.
  - Each summary is `{ id, title, status, settled, finishedAt?, error?, warning?, verification?: <status>, acceptance?: <status>, changedFileCount, diffSummary?, lastProgress?, numTurns?, providerRecoveryAttempts?, next }`.
  - `diffSummary` is the last non-empty line of `diffStat`.
  - `lastProgress` is capped at 300 characters.
  - `next` is a short fixed hint chosen by status. For `completed`: "pi_result for the summary, pi_patch to review/apply". For other terminal statuses: "pi_result for the error; pi_followup to continue". For `quarantined`: "pi_recover". For pending jobs: "pi_wait again".
  - Summary strings pass through the same sanitize path as `public()`.

**`pi_patch`**

- Input: `job_id`, `offset` (integer ≥ 0, default 0), `max_bytes` (integer 4096..262144, default 65536).
- It requires a terminal job with an artifact manifest. Otherwise it fails with `Patch requires a terminal job with an artifact snapshot`.
- What it produces: a unified diff that `git apply` accepts (`diff --git a/<p> b/<p>`, binary changes as `--binary` hunks, full index, no rename detection). The diff covers the job's public artifact export against `baseCommit` in `repository`:
  - Included: every entry of type `file` with `utf8` or `base64` encoding, every `delete`, and executable-mode changes.
  - Excluded: `reports/*` entries.
  - Entries with `omitted` encoding go into `omittedPaths` and make the patch not applicable.
- It is built from the immutable artifact snapshot, never from the live worktree, so a later followup cannot change an earlier job's patch.
- `applicable` is true only when all of these hold: `manifest.exportComplete`, no entry is redacted or omitted, every base path is a regular file or absent (not a symlink or submodule), and sanitizing the final patch text leaves it unchanged. Otherwise the patch is still returned for review, with `applicable: false` and `notApplicableReasons` (bounded).
- It must not write objects, refs or index entries to the user's repository. Temporary material lives under the job directory and is removed afterwards.
- Generation method, checked by the lead with a local `git apply` round trip:
  - Write the base version of each path under `<tmp>/a/<path>`. Take it from `git cat-file` at `baseCommit`, with its tree mode.
  - Write the public export version under `<tmp>/b/<path>`, with the entry's mode.
  - With `cwd=<tmp>`, run `git diff --no-index --binary --full-index --no-renames --no-prefix --no-ext-diff --no-color a b`.
  - Use a neutral git config: `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`.
  - Exit code 1 means there are differences.
  - Added files print as `diff --git b/p b/p` and deleted files as `diff --git a/p a/p`. `git apply` (`-p1`) accepts both. The round trip also covered binary files, deletes, mode flips and paths with spaces.
- Cache:
  - The patch is built on first request and cached at `<jobDir>/patch/changes.patch` with `<jobDir>/patch/patch.json` holding `{ version: 1, key, sha256, totalBytes, applicable, encoding, files, omittedPaths, notApplicableReasons }`.
  - `key` is the sha256 of `baseCommit` plus the non-report manifest entries.
  - The cache is written atomically (temp file plus rename) and checked against `key` and `sha256` on every read. A mismatch rebuilds it.
  - The full patch is bounded at 32 MiB; anything larger fails with `Patch exceeds bound`.
- Page output: `{ job_id, baseCommit, applicable, notApplicableReasons, totalBytes, sha256, encoding, offset, nextOffset, eof, files, omittedPaths, patchFile, text }`.
  - `files` is `[{ path, change: added|modified|deleted|mode, binary }]`, at most 256 entries, with a `filesTruncated` flag.
  - `patchFile` is the absolute host path of the cached patch, so a caller on the same host can run `git apply` without copying text through the model.
  - `encoding` is `utf8` when the whole patch is valid UTF-8. In that case pages end on a newline boundary at or below `max_bytes`; a single longer line is cut at a UTF-8 character boundary. Joining the pages reproduces the exact bytes.
  - Otherwise `encoding` is `base64` and pages are raw byte ranges.

**Other changes in this unit**

- `pi_result` `untrackedNote` now points to `pi_patch` for the complete change set.
- `pi_capabilities` gains `claudeCode: { version: 1, wait: { maxJobs: 8, maxWaitSeconds: WAIT_MAX }, patch: { maxPageBytes: 262144, maxPatchBytes: 33554432 } }`.
- The server `instructions` describe the loop: `pi_delegate` → `pi_wait` → `pi_result` → `pi_patch` → review → apply locally.

**Tests required** (node:test, RED before GREEN):

- `pi_wait` over the MCP stdio client with fake Pi:
  - `until=any` and `until=all`.
  - Timeout with pending jobs.
  - A queued job is actually waited on.
  - An unknown ID gives an error.
  - Progress notifications arrive when a progressToken is sent.
  - Output is compact JSON.
- `pi_patch` round trip:
  - A job adds a text file, modifies one, deletes one, adds a binary file, flips a file to executable, and touches a path with a space and nested directories.
  - Applying the joined pages to a fresh worktree at `baseCommit` with `git apply` reproduces the job's checkpoint exactly.
  - The user repo's objects, refs and index are unchanged.
  - Paging boundaries and `sha256` are correct.
  - A redacted-secret file gives `applicable: false`.
  - A non-terminal job is refused.
  - The cache is reused, and a tampered cache is rebuilt.
  - A followup that changes the worktree does not change the earlier job's patch.

### Unit B — Claude Code kit and guide (`claude/claude-code-kit/kit`, Luna worker)

Owner files:
- new `examples/claude-code/mcp.json` (host mode)
- new `examples/claude-code/mcp.internal.json` (internal Docker profile)
- new `examples/claude-code/agents/pi-worker.md`
- new `examples/claude-code/skills/pi-delegation/SKILL.md`
- new `docs/claude-code.md` (Korean)
- `README.md` (one link line)
- `docs/operations.md` (short `pi_wait` / `pi_patch` section)
- new `test/claude-code-kit.test.mjs`

**`pi-worker` subagent**

- A native Claude Code subagent that drives one Pi job. Its tools are only the `mcp__pi__*` tools it needs plus Read, Grep and Glob. It has no Bash, Edit or Write, and no `pi_cleanup` or `pi_recover`.
- Its loop:
  1. Confirm a committed base.
  2. Delegate with a `request_id` and explicit acceptance criteria.
  3. `pi_wait` until settled.
  4. Read `pi_result`.
  5. Review `pi_patch` critically.
  6. Use at most two followups.
  7. Report job ID, status, verification, changed files, risks, `patchFile` and an apply command.
- It never claims to have applied changes.

**`pi-delegation` skill.** For the main agent. It covers:
- when to hand work to Pi
- how to brief it
- parallel fan-out with `pi_wait until=any`
- integrating with `git apply --3way <patchFile>` on the same host, or from patch pages
- local verification
- the cleanup policy

**Guide** (`docs/claude-code.md`, Korean). It covers:
- setup for both profiles, with `claude mcp add` and `.mcp.json`
- installing the agent and skill at project or user scope
- a permission allowlist for read-only tools
- timeout and output-size notes
- example prompts
- limits

**Kit test.** Agent and skill frontmatter parse and have the required fields. Every `mcp__pi__<tool>` named in the kit exists as a `registerTool` name in `src/server.mjs`. The agent does not list `pi_cleanup`, `pi_recover`, Bash, Edit or Write. The JSON examples parse. Until Unit A merges, the test fails on `pi_wait` and `pi_patch` only, which is expected.

## Integration and verification

1. Merge Unit A, then Unit B, into the integration branch.
2. Run the full suite on gram in Docker (`node:24.22.0-bookworm` base image, `--network none`, task-scoped `/tmp` directory and `DOCKER_CONFIG`).
3. Independent read-only review: Astra if the bridge has room, otherwise the Fable reviewer.
4. Merge into local `main`, then commit `handoff.md` separately.

## Results

(filled after integration)
