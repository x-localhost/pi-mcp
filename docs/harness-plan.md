# Harness improvements — 2026-10-24

## Scope and base

User requested all improvements from the harness review: (1) file-URI confinement,
(2) symlink-safe storage availability, (3) consistent approved-MCP startup,
(4) inherited acceptance, (5) long-session context/rollover, (6) independent review,
(7) capability discovery, (8) tool tracing/stall detection and gateway correlation,
(9) reproducible task evaluation, plus a small durable parent workflow with an
aggregate observed budget. No deployment, push, paid/company model call, live MCP
or global setting changes, automatic commits/merges by the service, or new ambient
tools. Existing network/credential/isolation boundaries stay in force.

Inspected clean main and all worktrees. Committed integration base:
`52a13358c175950b12dec31f1eb5f0f421129cc2`.
Integration branch `codex/harness/integration`, absolute worktree
`/Users/leebw/workspace/claude/pi-mcp-worktrees/harness`.
Existing worktrees are preserved. Lead owns this coordination artifact, review,
scoped commits, serial integration, final verification and handoff.

Pre-assignment inventory: native `/root/harness_boundary_review` completed;
no active native delegates. Fresh Claude health: authenticated, activeJobs=0,
allowed roots `/Users/leebw/workspace/claude` and `/Users/leebw/Documents/Codex`.
Maximum three active assignments combined, two Claude jobs, no recursive delegation.
Independent native Astra design review precedes substantive feature implementation.

## Contracts

### Existing boundaries

Reject file URI forms before path authorization; actual released Pi tests must
prove external and encoded protected paths are denied. Storage accounting must
not follow symlinks; count link metadata safely, keep state-control path validation
strict, and do not let a normal repository symlink disable health/admission.

Approved MCP uses one exported bounded startup budget shared with worker
readiness. Independent active servers initialize concurrently, no server without
tools for the current mode starts, failed startup closes all started transports.
Call deadlines and existing fixed gateway routes remain enforced. A three-stage
six-second HTTP handshake must succeed within the overall startup budget.

### Acceptance and continuation

Keep `execution`, `verification` and new `acceptance` distinct. A strict versioned
acceptance contract contains required verifier IDs, required artifact paths and
an optional independent-review requirement. Followup/fork inherit it; missing
`verification_ids` inherits the parent selection. A child may add requirements,
not silently weaken inherited ones. The final artifact digest binds all evidence.
No contract means `not_requested`, never automatic acceptance. Verification with
mutable repository tests is explicitly distinct from administrator-packaged,
read-only external graders; do not claim adversarial isolation from the same UID.
Add immutable packaged grader-file support and hash validation, or a comparably
explicit protected-grader contract, while preserving existing verifiers.

`pi_review` creates a separate worktree from the terminal source's immutable CODE
checkpoint, fresh Pi session and review mode. It does not require a raw-session
checkpoint, does not inherit write permissions or author conversation, and binds
the review to the source code digest. Review findings alone are not a trusted
acceptance approval; any caller attestation is explicit, digest-bound and honest.

`pi_rollover` continues code from a terminal checkpoint in a fresh session with a
bounded structured handoff. Preserve objective, constraints, verified completion,
pending items and lineage. Ordinary followup automatically chooses safe rollover
before configured session limits where possible; raw prior sessions remain private
and immutable for that transition. An oversized raw session alone must not turn
valid completed code into unexplained execution failure or block fresh-code review.
Bound outgoing provider history before the internal gateway's message limit,
preserving system/authoritative task context, latest request and coherent tool
call/result groups. Record any history reduction explicitly; never silently lose
the task contract or claim lossless summarization. Use pinned Pi 1.4.0 hooks, no
extra unrequested model calls. Test actual Pi requests with a local mock.

### Discovery and observation

`pi_capabilities` returns safe versioned metadata: configured model, selectable
verifier/material IDs and descriptions, tool sets by mode, supported continuation
operations, limits and acceptance/context/observation capabilities. No credentials,
private config contents, executable arguments containing secrets, or unrestricted
tool registration. New tool inputs remain bounded and strict.

Persist bounded metadata-only tool start/end/duration/error, provider retry and
compaction events. Distinguish live heartbeat from last progress. Configurable
bounded idle/repeated-failure detection must stop truthfully and preserve code,
with no automatic replay of external side effects. Generated job/attempt/request
IDs connect worker and gateway diagnostics without prompts, headers or tool bodies.
Use Pi's `before_provider_headers`/`after_provider_response` hooks: private trace
headers are validated/consumed by gateway and never forwarded upstream. Session
extension and worker ownership contracts must be agreed before cross-unit edits.

### Evaluation and parent workflow

Separate runtime regression from agent task performance. Provide a versioned small
task set, offline trace/outcome replay grader, aggregate metrics and baseline
comparison CLI. Record task/source/config identity, success/retained constraints,
resume correctness, latency and observed usage; unavailable data stays unavailable.
Include negative fixtures for false completion, context loss and duplicated resume.
Provide an explicit opt-in live runner against a configured Pi MCP endpoint for
real task evaluation, but never invoke it against a paid/company endpoint here.
Offline replay results must never be presented as model capability measurements.

Build the parent orchestration as a separate module/CLI (thin MCP facade if useful),
not a general DAG engine. A persisted bounded sequential plan stores goal ID,
stage/next action, linked job and code digest, stop/block conditions and aggregate
observed token/cost budget. Restart/advance must use deterministic request IDs,
avoid duplicate jobs and require selected acceptance gates before later stages.
Unknown measured usage fails closed when an aggregate budget is configured;
in-flight overshoot remains explicit. Durable job references prevent cleanup of
workflow inputs. No autonomous deployment, recursive worker spawning or publication.

## Units, ownership, dependencies and resources

1. **Safety** — native GPT-6 Luna medium, small deterministic policy/storage edits.
   Own `src/policy.mjs`, `src/storage.mjs`, new `test/harness-safety.test.mjs`,
   `docs/harness-safety-report.md`. Branch `codex/harness/safety`, worktree
   `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness-safety`.
2. **Runtime** — native GPT-6 Sol high: cross-module acceptance, context/session,
   code-only review and capabilities. Own `src/{manager,worker,server,config}.mjs`,
   new acceptance/context/capabilities helpers and corresponding new tests, scoped
   existing runtime tests, runtime guide/report. Branch `codex/harness/runtime`,
   worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness-runtime`.
3. **Tools/telemetry** — native GPT-6 Sol high: concurrent MCP startup and trusted
   Pi/gateway observation hooks require security/concurrency integration. Own
   `src/{approved-mcp,policy-extension}.mjs`, `internal-agent/{gateway,profile}.mjs`,
   new observation helper, associated new tests/report. Branch
   `codex/harness/tools`, worktree
   `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness-tools`.
   Does not edit runtime-owned files; supplies exported constants/helpers and a
   precise worker/config contract. Runtime consumes reviewed committed dependency.
4. **Evaluation** — Sonnet 5 bridge, bounded independent runner/task fixtures/docs.
   Own new `evals/`, `scripts/evaluate-harness.mjs`, `test/harness-evals.test.mjs`,
   `docs/harness-evals.md`. No shared package/runtime edits. Bridge-created
   `codex/claude/<job>` worktree from committed plan; exact model and completion
   checked. Remote execution only; parent coordinates RED/GREEN if SSH not allowed,
   without bypassing any denial.
5. **Workflow** — native GPT-6 Sol high after runtime contracts are committed.
   Own new orchestration module/CLI/tests/report; core integration serialized with
   runtime owner. Durable transaction/idempotency work exceeds bounded Sonnet scope.
6. **Independent regression** — native GPT-6 Sol high tester, only after committed
   integrated handoff; own test/report artifacts, no implementation edits. Astra
   independent final review plus lead final review. Docs polish can use Luna if
   material; no extra paid reviewer for copy-only corrections.

All writing units verify absolute root, expected branch and base before edits,
are not alone in the repository, preserve others' changes and leave commits to
parent. Every new behavior follows RED -> GREEN -> affected regression with actual
commands/results recorded. No tests/install/builds/services on Mac.

Use gram (reachable, low load) and task-owned prefix
`/tmp/pi-harness-implementation-20261024/`, per-unit subdirectories/containers.
Existing image `pi-harness-review:52a1335` is Node 24.22.0 with pinned dependencies;
its source fixtures are incomplete, so mount the committed/full unit source and
all test/script/docs files when testing. Final acceptance builds a fresh image
from Node `24.22.0-bookworm`, with packaged approved-MCP fixture only in test image.
No published ports; network-none mocks/isolated profiles; no shared cluster changes.

Integration order: safety -> tools -> runtime -> evaluation -> workflow, with
reviewed dependency commits supplied to overlapping owners. Run targeted checks
per unit, one meaningful final full suite, actual Pi mock/context/review workflows,
and isolated-profile acceptance for changed gateway/profile boundaries.

## Completion criteria

Every numbered review item has executable behavior, focused regression evidence,
accurate operator documentation and no weakened existing security policy. All
delegates report exact files/commands/outcomes. Parent reviews diffs, commits and
integrates serially. Final independent tests run on an exact committed SHA. Keep
honest limitations for external corporate acceptance, per-user OS isolation,
semantic model quality and soft observed budgets. Update bounded root handoff in a
separate commit citing the work SHA. Fast-forward clean expected local main only
after final review; preserve integration branch if main is unexpectedly dirty.

## Assignment and review log

- Initial plan recorded before implementation; design review pending.
