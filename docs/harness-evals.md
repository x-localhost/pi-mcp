# Harness evaluation

This is a versioned, offline-first check of Pi MCP evidence binding. The bundled
ten tasks and synthetic outcomes exercise the grader; they are not a model
benchmark. Their target paths and verifier IDs are illustrative prerequisites
for a supplied task repository.

## Evidence

Suite `v1` has a digest over the complete parsed task definitions. A
task's runtime acceptance contract includes its required verifier IDs, changed
artifact paths, and optional review obligation. The grader uses the runtime's
canonical acceptance digest. The suite digest separately binds prompts,
criteria, and file-preservation predicates.

Completion requires an immutable code snapshot. Verification must match the
source job, code digest and contract. Review names a different review job and
an explicit caller attestation; caller authority is not an authenticated human
or trusted grader. No prose becomes approval. Retention checks only named
files in the source snapshot, not full API or instruction semantics. Unknown
unchanged-file or resume evidence cannot pass a required criterion. Resume
correctness means observed submission request-to-job idempotency, not agent
session semantic preservation. Usage requires measured available dimensions
and an observed response count.

Changed-path evidence includes deletions, so it can still show that a file was
not preserved. A required output also needs separate `artifacts.presentPaths`
evidence from the immutable code checkpoint; a deleted, absent, or unknown
required file never passes. File preservation is reported independently of
execution success: a failed execution may still have a proven retained file.
Reports derive success, applicability, categorical counts, and measured means
from their per-task rows. This enforces internal consistency, not the
authenticity of a self-consistent report supplied by a caller.

The synthetic baseline, regressed, and incomplete fixtures are executable.
The incomplete fixture records an observed execution without a code digest;
a missing selected-task outcome is separate.

## CLI

Offline replay:

`node scripts/evaluate-harness.mjs replay --fixture baseline --harness-commit <40-hex> --task-base-commit <40-hex> --config-fingerprint sha256:<64-hex> [--select id,id] [--out /abs/report.json]`

Bundled fixtures use harness commit 40 `1` digits, task base commit 40
`2` digits, and fingerprint `sha256:` plus 64 `3`
digits. Use `--fixture incomplete` for explicit incomplete execution.
`--traces /abs/bundle.json` accepts a bounded JSON trace array or
the live bundle below; add `--origin live` to replay that bundle.
Missing selected outcomes remain in all applicable denominators. Replay and
compare do not initialize Manager or load live config.

Comparison:

`node scripts/evaluate-harness.mjs compare --baseline /abs/base.json --candidate /abs/candidate.json [--allow-selection-mismatch] [--allow-observed-mismatch]`

Both selected and observed coverage must match by default. Optional flags
expose exact gaps. Candidate-minus-baseline latency, token and cost deltas use
only matched observed tasks. Source commits may differ, while suite, grader,
config fingerprint, and origin must match. Reports have strict versioned
shapes and bounded constructed output. Synthetic comparison remains labelled
as a grader check.

Live execution:

`node scripts/evaluate-harness.mjs live --live --ack I-UNDERSTAND-THIS-SUBMITS-TO-THE-CONFIGURED-PI-MCP-MANAGER --run-id run-1 --select fix-null-check --repository /abs/task-repo --base-commit <committed-sha> --state-dir /abs/private-state --config /abs/config.json --out /abs/live-bundle.json`

Live requires both controls. Selection is known, unique and at most 16 tasks;
all selected task content is pinned. The CLI verifies both the actual
evaluation checkout commit and the task repository's committed base before
Manager initialization. Per-task polling is 0–30000 ms (default 30000);
the whole run is 0–120000 ms (default 120000). A task not submitted by the
deadline remains a missing outcome, while a running task gets an incomplete
trace.

The config fingerprint is derived from the loaded normalized nonsecret
settings and selected provider/model, including defaults, verifier
declarations, state namespace, reasoning level, paths and network policy
names. A caller-supplied live fingerprint is not accepted. The fingerprint
does not hash mutable external models, auth or agent file contents; pin
those files separately if they can change between runs. Run identity also
covers the committed evaluation checkout SHA, complete task content and exact submission payload. Changing these
under one run ID rejects before Manager submission.
The evaluation source checkout must be clean for executable paths (`src/`,
`internal-agent/`, `evals/`, `scripts/`, and package manifests) before live
Manager initialization, so the reported harness SHA describes the code run.

The live output is a constructed `version:1` bundle with bounded
replayable traces and a report. `--out` writes a 0600 exclusive file;
stdout emits the same JSON without it. Required verifier IDs and canonical
acceptance are submitted. The adapter reads Manager snapshot, verifier,
artifact and caller review evidence. It never auto-attests, approves,
commits or deploys. A crash-stale run lock is recovered with Linux ownership
locking; state is private, bounded, no-follow and atomically written. Manager
request-ID tombstones remain authoritative after cleanup.
`--state-dir` remains accepted for CLI compatibility but does not select the
identity registry. Every run ID is recorded under the configured Manager
`stateDir/evaluation-runs`, so a different caller path cannot evade identity
checks. Live and offline CLI errors have bounded, generic diagnostics and do
not echo rejected input values.

The current Manager event API does not expose complete request-to-job
submission mappings. Live required-resume evidence therefore stays unknown;
one submission cannot prove idempotency. Actual event gaps are preserved.
Verification and file preservation may remain unknown when the immutable
snapshot or public artifact export cannot establish them.

The fake-Pi CLI integration test creates a task-private committed evaluation
checkout and private config on gram; it calls no model or network endpoint.
