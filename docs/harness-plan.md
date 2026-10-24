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
   code-only review and capabilities. Own `src/{manager,worker,server,config,verification}.mjs`,
   new acceptance/handoff/session/capabilities helpers and corresponding new tests, scoped
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
- Astra design review `/root/harness_design` accepted the bounded design with the
  following adopted amendments. This is design approval, not implementation approval.
- Acceptance evidence binds source job + stable `inputSnapshotDigest` + canonical
  contract digest. Every continuation recomputes acceptance; explicit empty
  selections cannot remove inherited requirements. Review jobs have provenance,
  separate readonly obligations and no inherited review approval. Caller review
  attestation is labelled as caller authority, never authenticated human identity.
- Required code-artifact paths count existing safe regular source files, including
  unchanged base files; reports/deletions do not satisfy them. Protected graders
  pin root-owned script/asset files by hash, not only an interpreter executable.
- Oversized session history does not invalidate completed code. Fresh transitions
  preserve private old history and seal it against future resume (including older
  aliases). Automatic rollover rejects stale lineage/code mismatch; explicit
  rollover intentionally selects the named immutable code snapshot. Mandatory
  handoff fields never silently truncate; model summaries are untrusted notes.
- Pi catches transform-hook exceptions, so the history guard must prove abort
  before network in actual Pi tests. Preserve authoritative task/system state,
  latest request and complete tool groups; count final serialized bytes/messages.
- Tools unit additionally owns `src/context-policy.mjs` (pure history guard) and
  `src/observation.mjs`. Runtime owns handoff/session helpers and passes policy
  `jobId`, `context` and `observation` settings plus bounded private metadata paths.
  Policy extension uses these helpers; runtime consumes the reviewed tools commit
  before final GREEN. New top-level administrator keys are `context` and
  `observation`; tools exports strict normalizers/defaults for runtime config.
- Observation records only constructed allowlisted metadata and local opaque IDs,
  never raw model tool-call IDs/args/results. Correlation headers are injected only
  for the fixed internal loopback gateway, consumed there and never sent upstream.
  Heartbeat is not useful progress; disabled/opt-in thresholds are explicit.
- MCP startup shares a deadline and Pi bootstrap margin, filters inactive servers,
  aborts all siblings on failure, settles all attempts and closes late successes.
- Workflow uses one lock order (workflow then submit; cleanup never acquires
  workflow lock). Durable intent/reference precedes submission. Source/reviewer
  references, including preparing intents, protect cleanup under submit lock.
  Required review may run while source acceptance is pending; implementation
  continuation waits for acceptance. Usage is counted once per unique child;
  missing dimensions block a configured budget. In-flight child overshoot remains
  explicit. Cancellation intent is persisted before delivery.
- Safety reviewed and committed `06e7257`: URI and symlink RED failures followed by GREEN 3/3 on gram, including
  released Pi denial, lexical-decoy review check and committed-symlink admission.
- Before feature launch: design reviewer and safety implementer completed;
  Claude activeJobs=0. Next assignments are runtime Sol, tools Sol, then eval
  Sonnet if combined active count remains below three. No recursive delegates.
- Gram `/home` is full; task uses its own `/tmp` buildx metadata directory. Root
  Docker storage has 267 GB free; no shared resources/settings were changed.
  Test image `pi-harness-implementation:test-20261024` includes root-owned approved
  MCP fixtures. Unit source/test/script/docs trees must still be mounted in full.

### Feature-unit integration interface

Tools exports `normalizeContext(raw)`, `normalizeObservation(raw)`, and
`POLICY_READY_TIMEOUT_MS` from its helpers/approved-MCP module. Configuration
normalization is strict and tools reports exact defaults to runtime. Worker policy
includes `jobId`, `context`, `observation`, `observationFile`, `activityFile` and
`stopFile` as private per-job paths. The extension writes bounded allowlisted
observation records and atomic latest activity/stop state; worker consumes them
into public events/lastProgressAt and truthfully stops on context/stall reasons.
Tools owns context reduction and hook lifecycle; runtime owns the watchdog,
session size/rollover and handoff. Runtime config passes these policies unchanged.
Trace injection requires an explicit internal gateway flag derived from the fixed
profile, never inferred from an arbitrary user URL. Helpers must work with defaults
when old fixtures omit optional fields. Both implementers confirm this interface
before coding and notify the lead of necessary revisions; no overlapping edits.

### Active assignments and workflow contract

- Runtime `/root/harness_runtime` (native Sol high) and tools
  `/root/harness_tools` (native Sol high) started from `50a55ce` in their recorded
  worktrees. Evaluation bridge job `task-834e646b-d1c9-4531-949f-437df7ae20a8`
  started from the same commit with explicitly requested Sonnet 5; final model
  identity and completion still require verification. Combined active count: 3.
- Evaluation worktree is bridge-owned under its state directory, branch
  `codex/claude/834e646b-d1c9-4531-949f-437df7ae20a8`; permitted repository and
  authenticated bridge health were confirmed immediately before delegation.
- Workflow will use bounded immutable sequential stage definitions and explicit
  create/status/advance/cancel operations. It stores intents before submission and
  resumes by deterministic request ID. Review collection is allowed while source
  acceptance awaits review; next implementation waits for the selected gates.
- Workflow lock precedes submit lock. Prepare/revalidate source and persist intent
  under submit lock, release it, then call Manager submission (which takes its own
  lock). Cleanup reads workflow references under submit lock without taking a
  workflow lock, matching both job IDs and request IDs. This protects children
  created just before a crash that prevented recording their returned job ID.
- Aggregate budget admission is between stages; a whole in-flight child can
  overshoot. Unknown selected usage dimensions block. This limit is explicitly
  reported, never advertised as a hard provider-spend cap. Cancel intent is durable
  before delivery. Completed/cancelled workflow references remain until explicit
  safe workflow release, preserving review and source evidence.

### Workflow implementation handoff

- Runtime confirmed stable APIs: `review(sourceJobId, input)`,
  `rollover(sourceJobId, input, {automatic:false})`, and
  `attestReview(sourceJobId, {review_job_id, verdict, request_id})`.
  Public evidence uses `acceptance.status`, `sourceJobId`,
  `inputSnapshotDigest`, `contractDigest`; review provenance uses
  `reviewSourceJobId/reviewSourceSnapshotDigest/reviewSourceContractDigest`.
- Evaluation Sonnet job completed without changes after its initial compound Git
  check was denied by the bridge command allowlist. Actual Sonnet 5 identity was
  verified in initialization metadata. No substitute model or denied command
  rerun was used. A narrow read-only Git allowlist decision is pending from user.
- With two active native jobs and zero active bridge jobs, workflow may start
  its standalone module/adapter tests against the committed interface now;
  manager cleanup wiring and actual integration remain serialized after runtime.
  This keeps useful independent work moving without copying dirty dependencies.

### Independent implementation review and correction units

- Workflow is committed at `619b388`; its remote tests passed 18/18, with
  existing cleanup checks 3/3. Runtime/tools and workflow are now integrated.
- Native Astra review of `0985441` found session seal admission/recovery races,
  lost continuation instructions, idle-progress false positives, incorrect retry
  identity, and review attestation acceptance/idempotency gaps. All are required
  corrections before the final regression and main integration.
- At correction assignment, workflow and runtime implementers are completed,
  the independent reviewer has completed, and Claude bridge active jobs are zero.
  Runtime Sol resumes in `harness-runtime-fixes`, branch
  `codex/harness/runtime-fixes`, base `619b388`, owning manager, worker, session
  transition, associated tests and report. Tools Sol resumes in
  `harness-observation-fixes`, branch `codex/harness/observation-fixes`, same base,
  owning policy extension, context policy, observation, their tests and report.
- Contract: tools emits content-free actual assistant progress and retains all
  authoritative user instructions; runtime limits idle checks to active Pi and
  carries a bounded continuation ledger across fresh sessions. No shared source
  writes. Both run targeted RED/GREEN on gram, without provider endpoints.
  Parent integrates serially, then requests Astra review of corrections and the
  committed workflow, runs the full suite and isolated mock internal profile.
- Evaluation remains blocked on the already pending narrow bridge Git permission
  decision; no substitute model or alternate execution route is authorized.
- The completed tools agent could not be reactivated because the native service
  reports its thread limit. The available runtime Sol will implement correction
  units serially in their separate worktrees, with the same role/model and no
  permission change. Astra separately reviews committed workflow recovery.
- Workflow review additionally requires exact Manager request identity during
  recovery/cancel, automatic rollover reconciliation, atomic acceptance/source
  validation with submission and release, review-child acceptance gates, truthful
  missing pricing/usage, and terminal cancelled-child accounting. After the
  runtime correction commit, the available Sol will handle these and the remaining
  context/observation fixes together in the unused observation-fixes worktree,
  fast-forwarded to the reviewed integration base. It also owns the necessary
  Manager internal admission interface in that serialized unit. This avoids
  competing writers and repeated dependency handoffs under the native thread cap.
- Parent preflight on committed `86a405f` reproduced an existing offline-material
  regression introduced by optional descriptions: normalization inserted an empty
  description, which a second validation rejected. The lead made the single-line
  fix to omit an absent optional field, within the small-change exception.
  The original material test failed with `Invalid offline material description`;
  the existing artifact/material plus capability suites then passed 14/14 on gram.
- Final integrated source `c52b85a` passed the focused correction checks. Parent
  built a fresh pinned image and started the full suite plus actual isolated Pi
  profile; native Astra is reviewing that committed source. No native tester was
  substituted after the native thread limit; the parent runs remote regression.
- Final review found a mixed Anthropic user block could lose authoritative text
  when grouped with a tool result. Actual profile acceptance also found the
  loopback relay discarded the new trace headers even though the worker's fixed
  profile marker was true. Review/approval/rejection/rollover passed up to trace
  correlation; this is a real integration failure, not a completed acceptance run.
- With one active Astra reviewer, zero active implementers and zero active bridge
  jobs, existing runtime Sol owns these two bounded fixes in
  `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness-final-fixes`, branch
  `codex/harness/final-fixes`, base `c52b85aeeffe74384c19dca5a557e56755e63ff0`.
  Scope: context policy, fixed relay trace forwarding, focused tests and report.
  Mixed user blocks must remain mandatory; only the existing diagnostic UUID trio
  may traverse the chat relay, with duplicate/malformed handling still fail-closed
  and no arbitrary or credential header forwarding. Parent owns integration and
  fresh-image regression/profile reruns after the committed handoff.

### Final verified state

- Final executable source `661a898e715ac16eb80224b880a3be8c7371cd93` includes
  all implemented safety/runtime/tools/workflow changes and review corrections.
  Independent Astra closed its last finding and approved integration after the
  parent checks. Fresh-image full regression passed **322/322**, 15 suites,
  no failures/cancellations/skips. Actual isolated Pi acceptance passed all
  boundaries and the new review/attestation/rollover/correlation probe.
- Observation contract was narrowed to what pinned Pi can actually expose:
  extension IDs describe logical calls/header hooks, gateway IDs describe observed
  ingress, and bounded repeated-call flags are diagnostic. No physical SDK retry
  counts or provider spend are inferred. The fixed chat relay preserves only the
  validated UUID trio; gateway consumes it before upstream.
- Source/context continuation preserves mandatory text and mixed tool-result/user
  blocks. Required or unknown image context refuses fresh rollover, and bounded
  handoff overflow refuses instead of truncating. Workflow uses the final atomic
  Manager admission interface; the earlier prepare-then-submit design was revised
  to recheck its gate under the same submit lock as actual admission.
- The evaluation unit remains unimplemented after the bridge denial and pending
  user permission decision. No model substitution, denied-command rerun, global
  configuration change or live bridge restart occurred. Therefore the original
  request to complete every improvement is not claimed fully complete.
- Evidence, exact commands, source/image identities, corrected failures, honest
  limits and cleanup are in [harness-regression.md](harness-regression.md).
  Parent owns final documentation/handoff commits and clean local-main merge.
