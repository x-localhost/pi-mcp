# Runtime operations for completion gaps 3–8

This guide describes the optional bounded runtime enabled by the administrator's Pi-MCP configuration. It assumes the isolated internal-agent profile, Linux `/proc`, `/usr/bin/flock`, Pi 1.4.0, and the packaged project toolchain. A new or changed configuration needs an internal-agent restart. These controls do not provide per-user OS isolation, a filesystem quota, or a hard monetary cap.

## Administrator configuration

The optional top-level sections below reject unknown keys and invalid values. The example shows the shape, not a site-specific provider or secret:

```json
{
  "queue": { "maxPending": 16, "maxWaitSeconds": 3600, "dispatchIntervalMs": 500 },
  "verification": {
    "maxSelected": 4,
    "commands": [
      { "id": "unit", "argv": ["/usr/local/bin/node", "--test", "test/unit.test.mjs"], "timeoutSeconds": 300, "maxOutputBytes": 65536, "readOnly": false }
    ]
  },
  "budgets": { "maxInputTokens": 100000, "maxOutputTokens": 20000, "maxTotalTokens": 120000 },
  "retention": { "maxStateBytes": 4294967296, "maxScanEntries": 100000, "terminalDays": 30 },
  "artifacts": { "maxFiles": 256, "maxFileBytes": 2097152, "maxTotalBytes": 33554432, "maxReadBytes": 65536 },
  "offlineMaterials": { "materials": [] },
  "approvedMcp": { "servers": [] }
}
```

Queue, verification, budget, retention, artifact, offline-material and approved-MCP declarations are administrator settings. Jobs select only material IDs and verifier IDs. Queued jobs pin the selected model configuration and security settings; current owned credentials may refresh, and are revalidated at admission. Verifier `argv` is an exact argument array: no shell parsing or runtime install. The executable must resolve to a root-owned, non-writable packaged path; the verified canonical path is what runs. `readOnly:true` permits a named verifier on a review job, but is an administrator declaration, not OS-enforced read-only execution. Review jobs otherwise cannot select that command. The separate Pi `allowedCommands` list does not grant verifier permission.

Defaults are the values shown for queue, retention and artifacts; verification has no commands and budgets have no thresholds until configured. `maxCostUsd` can be set in `budgets` only when the selected model reports usable nonzero pricing. Unknown or all-zero pricing fails before model execution; token limits can still be used. Limits use observed provider usage and cumulative session statistics, including compaction where Pi reports it. A response with missing, zero-only, negative or non-finite measured usage cannot establish an enforced budget and stops as `budget_unavailable`. An in-flight request can exceed a threshold before it is observed. Gateway per-request bounds complement, but do not turn this into a hard spending limit.

Offline material declarations pin IDs, manifest paths and SHA-256, source commits, destinations and collision policy. See [offline and artifact operations](offline-artifacts.md) for packing/import, LFS/submodule materialization and export format. Approved MCP servers are declared only by the administrator and only their named tools are admitted; see [approved MCP operations](approved-mcp.md). Neither feature enables ambient Pi MCP discovery or runtime network installation.

## MCP tools

`pi_health {}` reports Pi version, credential presence, active/queued counts, required tools, bounded state usage and retention candidate preview. Credential presence is not authentication proof. `pi_delegate` requires `repository`, `title`, `prompt`; it accepts `base_ref`, `mode` (`implement` or `review`), configured `provider`/`model`, `thinking_level`, `timeout_seconds`, `max_turns`, `request_id`, up to four inline `images`, `materials` IDs and `verification_ids`. A base reference resolves to a commit when submitted. The request ID is durable and idempotent for identical input, including after cleanup; reusing it for different input fails. A queued job expires after `queue.maxWaitSeconds`, separately from its run timeout, which starts at admission. Queued cancellation creates no worktree or worker.

`pi_status {job_id, wait_seconds?}` waits at most 45 seconds; `pi_list {limit?}` lists at most 50 summaries. A job may be `queued`, `starting`, `running`, `finalizing`, terminal, or `quarantined`. `pi_result {job_id}` returns a bounded, sanitized preview with explicit truncation flags and separate `execution`, `verification`, `budget`, artifact-completeness and usage fields. `pi_cancel {job_id}` requests a stop, including during verification. Keep polling until terminal or quarantined; a cancel request is not proof of stopped descendants.

`pi_followup {job_id, prompt, ...task options}` continues a terminal job in its existing worktree and Pi session. It cannot change its material selection or mode and is excluded while that worktree has an active or queued sibling. `pi_fork {job_id, prompt, ...task options}` requires a terminal job with complete immutable private code and Pi session checkpoints. It reapplies the pinned material baseline, restores that job's captured code and starts a distinct worktree/session branch at the captured conversation position. Later followups to the source do not alter this fork input. Forks do not replay external side effects or prove semantic independence of a remote model service.

`pi_events {job_id, cursor?, limit?}` returns up to 100 persisted sanitized metadata events, `nextCursor`, `latestCursor`, a dropped count and an explicit gap for evicted history. Model text deltas are not persisted. `pi_steer {job_id, message, images?}` accepts at most 2,000 message characters while the worker is running. `received` means the worker saw the control; `queued_by_pi` or `handled_by_pi` is Pi's RPC acknowledgement, not proof the model consumed the message. `unknown` means the ACK was lost or timed out; it is never replayed automatically. The sender can inspect job events/status before deciding to submit a new control. Raw processed control payloads are removed after durable receipt; pending controls and receipts are bounded.

Inline images on delegate, followup, fork and steer require `{mimeType,data}` with canonical base64 bytes and matching PNG/JPEG/GIF/WebP magic. URLs are refused; at most four images and 1 MiB decoded bytes total are accepted. The observed selected model must advertise image input. RPC frames are bounded at 4 MiB, and the internal gateway has its own 4 MiB request bound.

`pi_artifacts {job_id, cursor?, omission_cursor?, limit?}` pages public manifest entries and omissions for a terminal job. `pi_read_artifact {job_id, artifact_id, offset?, length?}` returns exact exported bytes as base64 plus page and whole-blob SHA-256 and `nextOffset`/`eof`; the default read length is capped by the administrator's `maxReadBytes`. Only the public sanitized manifest/blobs are exposed. Binary blobs without a detected secret retain exact bytes; secret-bearing binary is explicitly omitted. Public artifact completeness, redaction and applicability are explicit. Private raw checkpoints and sessions are never public artifacts. The host export helper writes a verified bundle to a new file and does not extract arbitrary archive paths.

`pi_recover {job_id, terminate?}` works only for quarantined jobs. Omit `terminate` for inspection. Explicit termination checks Linux boot ID, PID namespace, start identity and owned process groups; ambiguous evidence remains quarantined and retains capacity. It never uses a bare PID as a kill target. `pi_cleanup {job_ids?, older_than_days?, dry_run?}` defaults to a dry run. With no selection, that dry run previews terminal jobs older than `retention.terminalDays`; deletion requires explicit IDs or an explicit age filter and `dry_run:false`. Active, referenced or exported jobs are refused. The source repository is preserved. Owned worktrees, job state and shared sessions are removed only after branch/path/reference checks. Request-ID tombstones remain, preventing an old request from executing again.

The state scanner admits a new job only below the configured soft byte limit and within bounded file enumeration. It includes private/public artifacts, sessions, materials and staging under the state directory. Concurrent writes can exceed that soft limit; use a real filesystem quota outside Pi-MCP when hard disk protection is required. Linux `flock` serializes submission, artifact reads/export, recovery and cleanup. The lock inode stays in place; upgrade only after old agent processes stop, because older releases used a different lock protocol.

## Verification and artifact identity

The worker proves Pi and its process group stopped, captures a source digest, runs selected verifiers in managed groups, proves they stopped, then captures the source again. `passed` requires every selected command to exit zero and matching complete before/after source snapshots. A command failure, timeout or cancellation keeps its own status. Source mutation or an incomplete final capture yields `mutated_or_incomplete`/`unverified`; a still-live writer yields quarantine. `verification.json` is attached only after the final source snapshot is reconciled, so its status and digest match `pi_result`. With no selected commands, verification is `not_requested`, even if the model claims it ran tests.

Artifact identity covers Git-visible changes plus the declared imported-material baseline. It does not claim to capture arbitrary ignored build caches. Source commit and material digest are separate in the manifest. A public redacted export can be complete for reading but non-applicable as code; a private complete checkpoint is required for a fork. Reports and event stores have bounds, and any omitted or truncated content is marked rather than silently called complete.
