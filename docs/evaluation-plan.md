# Reproducible harness evaluation — 2026-10-24

## Scope and authority

The user asked to continue the remaining evaluation after the earlier bridge
permission question. Implement and run offline replay evaluation and provide an
explicit opt-in path for later live evaluation. Do not call a paid/corporate model,
change the production runtime, publish, push, deploy or modify live MCP/global
settings. Synthetic replay scores are grader/harness checks, not model capability.

Clean main/base: `edff46ff3ca260a73cf8e6a6166d6080ca484b80`.
Integration branch `codex/evaluation/integration`, worktree
`/Users/leebw/workspace/claude/pi-mcp-worktrees/evaluation`.
Existing user and previous review worktrees remain intact.

## Permission continuation

The previous Sonnet5 job `task-834e646b-d1c9-4531-949f-437df7ae20a8` made no
changes after its first Git identity command was denied. The new instruction to
proceed follows the specific request for task-folder read-only Git permission.
Apply that limited grant, not a general Bash/Git allowance or model substitution.
The installed bridge supports `CLAUDE_DELEGATE_CONFIG` on a new stdio connection.
Use the same installed bridge and same existing job/session with a private task
configuration adding only read-only identity/status commands for its exact
worktree. Keep allowed roots, model, restricted/dontAsk mode, existing denies and
all unrelated fields unchanged. No shared connection restart or global file edit.
Record before/after hashes proving live settings unchanged and remove the private
task configuration after the job ends. The task-specific connection is an
orchestration process, not a new service deployment.

The parent will fast-forward the clean existing bridge worktree to the committed
integration plan before resumption. The bridge's historical baseCommit remains
`50a55ce`; do not rewrite job/session state to hide that lineage. Every resumed
prompt must name the actual new committed input, and review compares against that
input. The exact Sonnet model and terminal result must be observed again.

## Evaluation contract

1. A versioned small task suite defines immutable IDs, scenario/prompt, independent
   criteria and stable expected evidence. Include successful completion, false
   completion, lost constraints, duplicate resume, stale verification/review,
   unavailable usage and incomplete execution. Expectations are separate from
   candidate outcome files; no candidate-declared `passed` flag is trusted.
2. Strict bounded trace/outcome input: task/run identity, source commit and config
   identity, execution, code digest, verifier/artifact/review evidence, retained
   constraint identifiers, resume request/job events, timing and measured usage.
   Reject malformed/extra fields, unbounded records and duplicate record IDs.
   Well-formed stale evidence, false completion and one resume request producing
   multiple jobs are graded failures. Repeated submissions mapping a request to
   the same job are valid idempotency evidence. Unknown
   data stays null/unknown and never silently passes a required criterion.
3. A pure offline grader produces per-criterion outcomes and failure categories,
   aggregate task success, instruction retention and resume correctness. Metrics
   include denominators/coverage; latency and usage aggregate only real observed
   values with unknown counts. Report versions, suite content digest, grader identity, selected task IDs,
   `harnessCommit`, `taskBaseCommit` and a secret-free configuration fingerprint.
   Bind verification/review evidence to job, code and contract digests. Retention
   uses suite-owned fixed evidence predicates, never candidate assertions alone.
   Offline grading checks evidence consistency, not authenticity. JSON output is deterministic for the same inputs; no ambient time,
   provider, filesystem/network reads or arbitrary executable graders.
4. A comparison CLI refuses incompatible suite/grader/task/config provenance by
   default, names missing coverage and reports candidate-minus-baseline changes.
   Source commits may differ intentionally. Task success uses the complete
   selected task set, including missing outcomes. Retention/resume report
   applicable and observed counts. Compare identical task coverage by default;
   latency/cost deltas use matched observed cases and disclose success differences. Matching synthetic positive and
   negative fixtures test the grader; they are labelled synthetic and are not
   presented as before/after model performance.
5. Offline is the default and needs no credentials or endpoint. Live execution is
   an explicit subcommand plus acknowledgement flag and bounded task selection,
   repository, committed ref and stable run ID. Use the existing configured
   Manager/Pi service; do not introduce an arbitrary command/URL executor or
   silently start it during replay/compare. Record actual runtime evidence and
   unavailable model/usage data truthfully. Stable request IDs prevent duplicate
   task submission when the operator retries the same run. Bind the run ID to
   suite/tasks, repository commit, configuration and payload; reject changed
   identity. Persist/reconcile submitted job IDs, bound waiting and return
   incomplete/running status truthfully. No automatic commits,
   deployment or review approval. Test the adapter with local fake Pi/Manager only.
6. CLI writes a bounded result only to an explicitly selected destination using
   owner-private, non-overwriting output; stdout is available. Reports do not copy
   credentials, raw private sessions, auth headers or tool output bodies. Export
   constructed evidence only, preserve event gaps and require usageAvailability
   before reporting usage. Truncated history cannot prove resume correctness.

## Units and checks

Before assignment: bridge health authenticated Max, allowed roots include the
repository, activeJobs=0. Native Astra reviewer was completed; all prior native
implementation jobs are completed. Maximum combined active assignments3, native3,
bridge2; no recursive delegation.

- Independent native Astra: review this contract before implementation, then final
  committed diff/results. Read-only, no providers, mutations or local tests.
- Existing Sonnet5 bridge implementer: owns `evals/`,
  `scripts/evaluate-harness.mjs`, `test/harness-evals.test.mjs`, any narrowly scoped
  fake evaluation fixture, `docs/harness-evals.md` and its unit report only. No
  `src/`, package/dependency, global settings or unrelated documentation changes.
- Parent: plan/interfaces, private bridge connection, remote RED/GREEN orchestration,
  review, scoped commits, serial integration, final evaluation/report/handoff.
  Use the exact Sonnet role constraints with GPT-6 Astra substituted as lead.

Sonnet first writes tests only, then stops. Parent executes RED on gram and returns
actual output before GREEN implementation. Parent may coordinate tests because SSH
is not in the bridge allowance; do not ask the worker to attempt denied SSH/local
tests. Use gram task root `/tmp/pi-harness-evaluation-20261024`, isolated Docker
Node `24.22.0-bookworm`, no published ports and no real provider credentials. Build
the pinned project image remotely only if adapter tests need dependencies.

Then review/commit the implementation, run focused tests, execute the versioned
offline suite and baseline comparison at the committed source, inspect deterministic
replay and explicit live-mode guards, and obtain independent Astra review. Run
existing affected checks or a full suite if integration concerns justify it.
Record every command, actual result, limits and final source SHA. Commit docs and a
separate bounded root handoff, then fast-forward clean local main. Preserve evidence
while removing only task-owned remote resources and private permission files.

## Independent design review

Native Astra reviewer `/root/harness_design` approved the small approach with six
validity amendments, incorporated above: malformed-versus-unsuccessful inputs,
independent evidence, precise provenance, stable denominators, exact retries and
constructed evidence with explicit usage/event availability. Review was read-only;
no unresolved design objections remain before the tests-only handoff.

## Initial implementation review and corrective unit

The first GREEN candidate's parent-run remote focused suite produced41/42 passed
on gram; one comparison fixture conflicts with its trace provenance. Parent code
review also found unfinished live evidence collection, runtime contract binding,
crash-safe run locking, configuration identity, bounded CLI guards and strict
report comparison. Details are in [evaluation-review.md](evaluation-review.md).
These are implementation defects/gaps, not a permission issue. The corrected
Sonnet job writes normally under its existing four approved identity commands.

After its terminal handoff, parent will commit the reviewed initial candidate on
the isolated task branch (not main) and integrate it with the review record. A
GPT-6 Sol implementation unit will own the substantial schema, transaction and
concurrency corrections, with targeted remote RED/GREEN and a real Manager/fake-Pi
roundtrip. This routing follows the global rule for substantial schema and
concurrency work after the bounded Sonnet attempt. Scope remains evals/, the
evaluation CLI/tests/fixtures and evaluation guide/report; no production runtime
or package/global edits. Each writer uses its own committed-base worktree.

Parent retains final review, commits and remote regression; independent native
Astra must review the corrected committed diff. Only clean verified integration
may fast-forward local main.

Corrective handoff: integration candidate `1c27ed55fc1f64b63443579992b7a4e4e1166bf4`
(initial Sonnet work `0644560`), still unverified and not merged to main. Writer
worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/evaluation-corrections`,
branch `codex/evaluation/corrections`, based on that exact candidate. Before
assignment native `/root/harness_runtime` (Sol) and `/root/harness_design` (Astra)
are completed, bridge activeJobs=0 and GREEN job
`task-25710c18-f17c-4e05-a51b-8cf9c6692fe8` terminal completed with no permission
denials. Reuse native Sol for corrective implementation and native Astra for
independent final review; no recursive delegation. Shared image is read-only
`pi-harness-evaluation:20261024`; corrective remote root is
`/tmp/pi-harness-evaluation-corrections-20261024`, with task-specific container
names, no ports/providers. Parent will not run a competing test on that root.
