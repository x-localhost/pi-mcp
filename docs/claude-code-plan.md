# Claude Code subagent support plan — 2026-10-26

Request: make Pi MCP comfortable to use as a subagent from Claude Code, adding the features that are worth having.

Base: clean `main` `3da6b20`; units start from the integration commit that records this plan. Integration branch `claude/claude-code-kit/integration`, worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/claude-code-kit`.

## Gaps observed (main `3da6b20`)

- Waiting costs many tool calls. `pi_status` waits at most 45 s and returns the full public job (about 50 keys). A 20-minute job therefore takes 25+ polls, and each poll puts the whole record into the caller's context. A queued job is not waited on at all, because `status()` returns immediately for `queued`. There is no way to wait on several jobs at once.
- There is no complete change set to review or apply.
  - `pi_result` gives a 24,000-character diff preview of tracked files only, and says "inspect artifacts for new files".
  - Artifacts are exact but come as base64 file snapshots. That is costly for an LLM to read and cannot go to `git apply` as it is.
  - Followups reuse the same worktree. So once a followup runs, the live worktree no longer matches the earlier job, and only the job's checkpoint does.
- Output uses pretty-printed JSON with 2-space indent, which spends tokens on whitespace in every response.
- There is no ready-made Claude Code setup: no subagent definition, no skill describing the delegate → wait → review → apply loop, and no guide to `claude mcp add` or the `.mcp.json` setup.

## Claude Code facts (official docs, checked 2026-10-26)

**Tool-call timing**

- A stdio MCP tool call has no per-request timer.
- The per-call wall-clock limit is `MCP_TOOL_TIMEOUT`, default about 28 h. A per-server `timeout` in `.mcp.json` is a hard limit that progress does not extend.
- The idle timeout is `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, default 30 min for stdio. Progress notifications count as activity.
- In the main conversation, a call still running after 2 min moves to the background automatically.

**Output size**

- Output over 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`), or text over 50,000 characters, is saved to a file under `~/.claude/projects/…/tool-results` and Claude reads it on demand.
- A tool may raise the character limit to 500,000 with `_meta["anthropic/maxResultSizeChars"]`.
- An `isError` text longer than about 11,000 characters keeps only its head and tail.
- Claude reads `content[].text`. How `structuredContent` is handled is not documented.

**Subagents**

- Subagent `.md` frontmatter: `name` and `description` are required. Optional fields include `tools` (accepts `mcp__pi__*` wildcards), `disallowedTools`, `model`, `mcpServers`, `maxTurns`, `skills`, `background` and `effort`.
- Subagents started from the main conversation run in the background by default.

**Plugins and MCP config**

- Plugin MCP tools are renamed to `mcp__plugin_<plugin>_<server>__<tool>`. A plugin package would therefore need different tool names in the agent file. Plugins are deferred and the kit ships as copyable project/user files.
- `.mcp.json` supports `${VAR}` and `${VAR:-default}`.
- The CLI form is `claude mcp add --scope project --transport stdio --env K=V <name> -- <command> [args…]`.

## Design (revised after Astra design review, job `task-e081a7bb`)

Three units, run in parallel against the fixed tool contract below. Each unit works in its own worktree created from integration commit `BASE` (the commit that records this plan). Server-file overlaps are small and the lead resolves them at integration:
- `src/server.mjs`: A registers `pi_wait`; P registers `pi_patch`.
- `test/mcp.test.mjs`: each unit adds its own tool name to the list.

### Unit A — wait, compact output, request context (`claude/claude-code-kit/wait`, Sonnet implementer)

Owner files:
- `src/server.mjs`, except the `pi_patch` registration
- `src/manager.mjs`, new `wait()` method only
- `src/capabilities.mjs`
- new `test/claude-code-wait.test.mjs`
- `test/mcp.test.mjs`, tool-name list only
- `docs/completion-runtime.md`, the `pi_wait` and compact-output lines only

**Compact output.** `out()` emits `JSON.stringify(data)`. Keep the text-content envelope, the error behaviour and the sanitize ownership as they are. There is no new pass that sanitizes the whole response.

**Request context.** `wrap()` passes the MCP handler's second argument (`extra`: `signal`, `_meta.progressToken`, `sendNotification`) through to the tool function. Existing tools ignore it.

**`pi_wait`** (`readOnlyHint: true`)

Input:
- `job_ids`: 1–8 task IDs, duplicates rejected.
- `wait_seconds`: number 0..300, default 45.
- `until`: `any` or `all`, default `any`.

Semantics:
- Settled means a terminal status or `quarantined`. Pending means `queued`, `starting`, `running` or `finalizing`.
- Quarantined counts as settled for waiting, but its `next` hint says it is unsafe to patch or follow up and should be reported or passed to `pi_recover`.
- Every ID is validated and read before any early return. An unknown job fails the call with `Job not found: <id>`.
- Jobs that are already settled satisfy the condition immediately.
- `wait_seconds: 0` makes exactly one observation round.
- Rounds run about once per second, never overlap, and each pending job is observed through `manager.status(id, 0)`. That call takes no global lock in the normal case, and queue expiry and stale-worker recovery still apply. A settled observation is cached for the rest of the call and not re-read.
- The deadline is monotonic (`performance.now()`), and every sleep can be aborted.
- When `extra.signal` aborts, polling and notifications stop. Pi jobs are never cancelled. The abort is not turned into a tool-error result; the handler just stops, and the SDK discards the reply.

Progress:
- When `extra._meta?.progressToken !== undefined` (token `0` is valid), send `notifications/progress` about every 10 s.
- The payload is `{ progressToken, progress: <elapsed whole seconds, strictly increasing>, total: wait_seconds, message: "<settled>/<n> settled" }`.
- Without a token, nothing is sent. A failed notification send is ignored.

Output: `{ until, timedOut, elapsedSeconds, settled: [ids], pending: [ids], jobs: [summary] }`.
- `timedOut` means the condition was still false at the deadline.
- Each summary is `{ id, title, status, settled, finishedAt?, error?, warning?, verification?, acceptance?, changedFileCount, changedFileCountIsLowerBound, diffSummary?, lastProgress?, numTurns?, providerRecoveryAttempts?, next }`.
- `verification` and `acceptance` are status strings only.
- `changedFileCountIsLowerBound` is true when `changedFiles.length >= 200`.
- `diffSummary` is the last non-empty line of `diffStat`. It covers tracked files only, and the field says so in the docs.
- Every string is bounded: `title` 150, `error`/`warning` 500, `lastProgress` 300 characters. All come from `manager.public()` output, so they are already sanitized.
- `next` is a fixed hint:
  - `completed`: `"pi_result for the summary; pi_patch to review or apply"`
  - other terminal statuses: `"pi_result for the error; pi_followup to continue"`
  - `quarantined`: `"unsafe: report it; pi_recover inspects ownership"`
  - pending: `"pi_wait again"`
- Callers that fan out should drop settled IDs before their next `until: any` call (documented in the tool description).

**Capabilities.** `pi_capabilities` gains `claudeCode: { version: 1, wait: { maxJobs: 8, defaultWaitSeconds: 45, maxWaitSeconds: 300, pollMs: 1000, progressMs: 10000 }, patch: { maxPageBytes: 262144, defaultPageBytes: 65536, maxPatchBytes: 33554432 } }`.

**Server instructions.** Add one sentence for agents: `pi_delegate` → `pi_wait` → `pi_result` → `pi_patch` (metadata first) → review → apply in a clean local worktree. Waits over 45 s need a client whose request timeout allows them.

**Tests** (RED before GREEN, through the MCP stdio client with fake Pi):
- compact JSON output
- `until=any` and `until=all`
- timeout with pending jobs
- a queued job is actually waited on
- an already-settled job returns immediately
- `wait_seconds: 0`
- duplicate and unknown IDs
- quarantine counts as settled
- progress notifications arrive with a token, including token `0`, and none arrive without one
- a client-side request cancellation stops the wait while the job keeps running
- two `pi_wait` calls run in parallel

### Unit P — `pi_patch` and patch export (`claude/claude-code-kit/patch`, Sol implementer)

Owner files:
- new `src/patch.mjs`
- `src/manager.mjs`, new `patch()` method plus the `pi_result` `untrackedNote` text
- `src/artifacts.mjs`, shared validation helpers only, with no change to snapshot behaviour or manifest format
- the `pi_patch` registration in `src/server.mjs`
- new `internal-agent/export-patch.mjs`
- `docs/offline-artifacts.md`
- new `test/claude-code-patch.test.mjs`
- `test/mcp.test.mjs`, tool-name list only

**`pi_patch`** (`readOnlyHint: false`, because it writes a cache)

Input:
- `job_id`
- `offset`: integer ≥ 0, default 0
- `max_bytes`: integer 4096..262144, default 65536
- `include_text`: boolean, default true. When false, the call returns metadata only.

Inputs and validation:
- The job must be terminal. `quarantined` is refused.
- The artifact manifest must be valid, and its `manifestSha256` must equal `job.artifacts.manifestSha256`.
- `sourceBaselineCommit` must equal `job.baseCommit`.
- Every public blob's size and sha256 are checked before use.
- The canonical repository must still be inside `allowedRoots`.

What goes into the patch:
- Source entries are manifest entries of type `file` or `delete`. Report entries are excluded by `entry.type === 'report'`, not by path prefix, so a real source file under `reports/` is included.
- Omissions come from `manifest.omissions` and from entries with `encoding: 'omitted'`. Both go into `omittedPaths` (bounded) and make the patch not applicable.
- A redacted entry path (where `redacted` is set and the path differs) is never used to look up a base file. That entry makes the patch not applicable and is left out.

Base content:
- Paths are resolved literally through tree metadata: `git ls-tree -z --full-tree <base> -- <path>` with `GIT_LITERAL_PATHSPECS=1`, and each ancestor is checked to be a tree.
- A symlink or gitlink at the leaf or any ancestor, or any mode other than `100644`/`100755`, is unsupported. The path is left out and the patch becomes not applicable.
- Blob size is checked with `git cat-file -s <oid>` before reading. Per-file and aggregate limits match the artifact bounds (`maxFileBytes` and `maxTotalBytes`). Oversized base deletions are left out and make the patch not applicable.
- The blob itself is read with `git cat-file blob <oid>`.

Secret policy, applied to both sides before git encodes anything:
- Base text (valid UTF-8 without NUL bytes) is passed through the same sanitize function. If that changes it, the sanitized text is used and the patch becomes not applicable.
- Base binary is scanned like `snapshotArtifacts` does (latin1 and utf8 probes). If a secret is found, that path's change is left out entirely and the patch becomes not applicable.
- After generation, the final patch text is sanitized again. If that changes anything, only the sanitized bytes are returned and the patch is not applicable.
- Unsanitized bytes are never cached or returned.

Git isolation (every git call):
- Strip inherited `GIT_*` variables from the environment.
- Set `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_NO_LAZY_FETCH=1`, `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`.
- Bound every call: about 30 s timeout, `maxBuffer`, and a stderr cap.
- For the diff, also set `GIT_CEILING_DIRECTORIES` to the staging parent and pass `-c core.attributesFile=/dev/null`.

Generation:
- Run `git diff --no-index --binary --full-index --no-renames --no-prefix --no-ext-diff --no-textconv --no-color a b` with `cwd` set to the staging directory.
- `a/<path>` holds the base blobs with their tree modes. `b/<path>` holds the public bytes with the entry modes.
- Exit code 1 means there are differences. Exit code 0 means an empty patch. Anything else is an error.
- Output is bounded at 32 MiB; anything larger fails with `Patch exceeds bound`.
- This method was checked with a lead round trip: added files print as `b/p b/p` and deleted files as `a/p a/p`, and `git apply -p1` accepts both, together with binary files, mode changes and paths containing spaces.

Cache and concurrency:
1. Under the manager lock, read the job and the manifest and copy the verified inputs. The public blobs are copied as bytes into staging.
2. Build in `stateDir/patch-staging/<uuid>`, outside the job directory, so `pi_cleanup` never races a partly built job directory and nothing ever recreates the job directory. Use no recursive mkdir of the job directory.
3. Reacquire the manager lock. If the job still exists with the same `manifestSha256`, publish `<jobDir>/patch/` (created non-recursively, mode 0700). Write the immutable files `changes-<key>.patch` and `meta-<key>.json`, then rename the descriptor `patch.json` into place last.
4. The descriptor holds `{ version: 1, generator: 1, key, manifestSha256, baseCommit, sha256, totalBytes, encoding, applicable, notApplicableReasons, files, filesTruncated, omittedPaths, inputSnapshotDigest, inputMaterialsDigest }`.
5. `key` is the sha256 of `generator` + `baseCommit` + `manifestSha256` + a digest of the current sanitize configuration (secret values hashed, never stored).
6. Reads use the existing no-follow regular-file helpers and re-verify `key` and `sha256`. Any mismatch rebuilds the cache.
7. Staging directories older than 1 h whose names match the generator pattern are reclaimed on each build.
8. If the job vanished, fail with `Job not found`.

Page output: `{ job_id, baseCommit, applicable, applicableMeaning, notApplicableReasons, totalBytes, sha256, encoding, offset, nextOffset, eof, files, filesTruncated, omittedPaths, inputSnapshotDigest, inputMaterialsDigest, patchFile, patchFileNote, text? }`.
- `applicableMeaning` is the fixed sentence: "complete, unredacted patch of supported exported source changes relative to baseCommit; not proof of target compatibility, verification, acceptance or review".
- `patchFile` is the absolute path on the server filesystem. `patchFileNote` is: "server path; not visible from the host in the internal Docker profile; save and verify sha256 before pi_cleanup".
- `files` is `[{ path, change: added|modified|deleted|mode, binary }]`, at most 256 entries.
- With `encoding: utf8`, a page ends at the last `\n` within `max_bytes`. A single longer line is cut at a UTF-8 character boundary. Joining the pages gives the exact bytes.
- With `encoding: base64`, pages are raw byte ranges, and each page is decoded before joining.
- An offset beyond the end, or one not on a page boundary for UTF-8 (for example mid-character), is an error.

**Internal export.** `internal-agent/export-patch.mjs <job-id>` mirrors `export-artifacts.mjs`: it checks the sandbox and profile, then calls `manager.patch()`, building the cache if needed. It writes the exact cached patch bytes to stdout and prints `{ sha256, totalBytes, applicable }` JSON on stderr. It does not set `exportedAt`. The host user runs `docker compose … exec -T agent node /app/internal-agent/export-patch.mjs <id> > job.patch` and checks the sha256.

**Docs.** In `docs/offline-artifacts.md`, replace "Public Git binary patches are never emitted" with the new rule: binary hunks only come from public bytes that passed the scan, the base side is scanned too, and the applicable meaning is the sentence above. Add apply guidance: `git apply --check` and then `git apply` in a clean integration worktree at `baseCommit`. `--3way` is an explicit option for diverged targets, because it touches the index and can leave conflicts. Unchanged imported materials are not part of the patch.

**Tests** (RED before GREEN):
- A round trip through the MCP client: add a text file, modify one, delete one, add a binary file, flip a mode, use a path with a space, nested directories and a non-ASCII path, and include a real `reports/x` source file. Joining the pages and applying them to a fresh worktree at `baseCommit` must reproduce the checkpoint, and the user repository's objects, refs and index must stay unchanged.
- An empty change set.
- Paging, including non-ASCII and invalid offsets, and the `base64` encoding path.
- `include_text: false`.
- A secret in base-only context or deleted lines yields sanitized output with `applicable: false`.
- A secret-bearing base binary is left out.
- A real omission without an entry.
- An unsafe ancestor (symlink or gitlink) in the base.
- An oversized base deletion.
- A non-terminal job and a quarantined job are refused.
- The cache is reused.
- A tampered `patch.json` or patch file is rebuilt.
- Concurrent generation from two managers.
- `pi_cleanup` during or after generation does not recreate the job.
- A followup does not change the earlier job's patch.
- `export-patch.mjs` validates its arguments (syntax check plus a unit test of its core where practical).

### Unit B — Claude Code kit and guide (`claude/claude-code-kit/kit`, Luna worker)

Owner files:
- new `examples/claude-code/mcp.json` (host mode)
- new `examples/claude-code/mcp.internal.json` (internal Docker profile)
- new `examples/claude-code/agents/pi-worker.md`
- new `examples/claude-code/skills/pi-delegation/SKILL.md`
- new `docs/claude-code.md` (Korean)
- `README.md`, one link line
- `docs/operations.md`, a short `pi_wait`/`pi_patch` section
- new `test/claude-code-kit.test.mjs`

**`pi-worker` subagent**

Frontmatter:
- `name: pi-worker`
- a `description` saying when to use it
- `tools`: only `mcp__pi__pi_health`, `pi_capabilities`, `pi_delegate`, `pi_wait`, `pi_status`, `pi_result`, `pi_patch`, `pi_events`, `pi_followup`, `pi_cancel`, plus `Read`, `Grep`, `Glob`. No Bash, Edit or Write, and no `pi_cleanup`, `pi_recover`, `pi_attest_review` or `pi_steer`.
- `model: sonnet`

The parent supplies the repository path as the server sees it and a resolved commit SHA. The worker loop:
1. Delegate once with a stable `request_id`. Reuse that ID only for exact retries, and give each followup a new ID. Use explicit acceptance criteria. Check that the returned `baseCommit` equals the given SHA.
2. Call `pi_wait` (`wait_seconds: 300`) until the job settles. Use at most 12 rounds, then report that it is still running.
3. If the job is quarantined, report it and stop.
4. Read `pi_result`.
5. Call `pi_patch` with `include_text: false`, then review the text pages critically.
6. Send at most two followups. The latest followup's patch is cumulative, so review it once.
7. Report: job ID, status, verification, acceptance, changed files, risks, `applicable`, `sha256`, `patchFile`, and an apply command. The command depends on the profile: same host uses `git apply --check` then `git apply`; the internal profile uses `export-patch.mjs`.

It never claims to have applied changes.

**`pi-delegation` skill.** For the main agent. It covers:
- when to hand work to Pi and when not to
- briefing Pi with a committed base and acceptance criteria
- parallel fan-out with `pi_wait until=any`, dropping settled IDs
- integrating in a clean worktree with `git apply --check` / `git apply`, with `--3way` only as an explicit option
- running local verification
- the cleanup policy: save the patch first; `pi_cleanup` is a human decision

**Guide** (`docs/claude-code.md`, Korean). It covers:
- the requirements: a Linux runtime for host mode, or the internal Docker profile
- setup through `claude mcp add --scope project --transport stdio --env PI_MCP_CONFIG=… pi -- node …/src/server.mjs` and `.mcp.json`
- installing the agent and skill at project or user scope
- permission guidance: read-only tools are `pi_health`, `pi_capabilities`, `pi_status`, `pi_wait`, `pi_result`, `pi_events`, `pi_list`, `pi_artifacts` and `pi_read_artifact`. `pi_patch` writes only its own cache. Mutating delegation tools stay behind an approval prompt.
- timeout facts: stdio has no per-request timer; idle time is limited to 30 min; waits are bounded at 300 s
- output-size facts: results over 25k tokens are saved to a file; use `include_text: false` first
- usage examples and limits

**Kit test.**
- Agent and skill frontmatter parse and have the required fields.
- Every `mcp__pi__<tool>` named in the kit exists as a `registerTool` name in `src/server.mjs`.
- The agent's `tools` excludes `pi_cleanup`, `pi_recover`, `pi_attest_review`, Bash, Edit and Write.
- The JSON examples parse and contain `mcpServers`.

Before integration, this test is expected to fail only on `pi_wait` and `pi_patch`. The unit report must show exactly that.

## Integration and verification

1. Merge units A, P and B serially into the integration branch, and resolve the `server.mjs` and `mcp.test.mjs` list overlaps.
2. Run the full suite on gram in Docker: image built from `node:24.22.0-bookworm`, `--network none`, a task-scoped `/tmp/pi-mcp-claude-code-20261026` directory, and `DOCKER_CONFIG` pointed there.
3. Run an independent read-only review (Astra reviewer).
4. Merge into local `main`, then commit `handoff.md` separately.

## Unresolved tradeoffs

- Claude Code alone would tolerate waits longer than 300 s. The cap follows Astra's recommendation so that generic MCP clients stay safe. A 30-minute job takes about 6 `pi_wait` calls.
- A Claude Code plugin package is deferred, because plugin MCP tool names (`mcp__plugin_<p>_<s>__*`) would fork the agent's tool list.
- `exportComplete` includes reports, so a redacted report alone makes a source patch not applicable. This is conservative, and kept on purpose.

## Results — 2026-10-26

All runs were on gram with image `pi-mcp-cck:base-20261026` (`node:24.22.0-bookworm` + rg/fd + locked deps) and `--network none`, using `/tmp/pi-mcp-claude-code-20261026/run-suite.sh`.

| Tree | Full suite |
| --- | --- |
| Base `1253842` (plan only) | 467/467 |
| Units A+P+B integrated `a146f5f` | 500/500 |
| Review fixes round 1 `8f40dbd` | 504/504 |
| Round 2 `4124ba3` | 508/508 |
| Round 3 `f9af8bf` | 517/517 |
| Final `4eb3974` | see handoff |

Units:
- Kit (Unit B) was built by GPT-6 Luna (bridge `luna_worker`, job `task-76ed3783`). The lead moved the operations section and added the subagent usage example.
- `pi_wait` (Unit A) and `pi_patch` (Unit P) were built by native Sonnet implementers. Unit P was planned for GPT-6 Sol, but bridge jobs cannot reach gram for TDD, so it went to Sonnet.
- Lead edits: the abort-listener cleanup in `wait()` and a test timing fix; the env-secret cache key, child env for `export-patch.mjs` and staging cleanup; a fail-closed probe for non-UTF-8 patches; and keeping worker credential collection inside the per-file `try`.
- The RED/GREEN commands and observations are in each unit report (lead transcript). Each unit's focused tests ran 3× for stability.

Independent review — Astra (`astra_reviewer`):
- Round 1 (`task-87aa8b1a`) rejected: binary/path secret escape, sanitized size bound, wait abort, omission bound, git env in `repository()`, untested cleanup race.
- Round 2 (`task-b1837463`) rejected: git octal-quoted non-ASCII paths bypassed the sanitizer; omission accounting; initial-sweep abort.
- Round 3 (`task-419aad2e`) rejected: literal `auth.json`/`models.json` credentials were missing from patch sanitization.
- Round 4 (`task-fb9899ce`) approved with no blocking findings. Its two remaining should-level notes:
  - Collector containment is fixed in `4eb3974`.
  - The overlapping-cleanup test still depends on scheduling. `sanitize()` is synchronous, so the build cannot be held open without a seam inside `completeAndRunDiff`. Correctness rests on publication re-reading the job under the lock and never recreating the job directory.

Not verified:
- A live Claude Code session driving the kit. There is no paid model call and no live MCP or global settings change.
- Real corporate LLM behaviour.
- The internal Docker profile's `export-patch.mjs` against a real compose stack. It is covered by unit tests only.
