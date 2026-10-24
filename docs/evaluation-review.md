# Evaluation implementation review — 2026-10-24

The independent design review approved the contract in
[evaluation-plan.md](evaluation-plan.md). The following parent review findings
refer to the initial Sonnet implementation, still under construction at review
time. They are implementation gaps, not permission blockers. Resolve against a
committed handoff, with focused failing regression tests before fixes. Preserve
all no-provider, isolated-worktree and remote-compute constraints.

## Blocking checks for the committed handoff

1. **Live evidence/contract path.** `submitLiveRun` currently submits only the
   prompt; it omits selected verifier IDs and acceptance. The live CLI exports
   job status instead of a replayable bounded trace. `taskContractDigest` differs
   from runtime `contractDigest` and omits some evaluation predicate details.
   Bind runtime verifier/review evidence using the actual canonical acceptance
   contract, and retain the suite digest for the complete evaluation contract.
   Collect allowlisted evidence from Manager APIs, never fabricate the expected
   digest or treat a model's prose as review approval. Missing preservation or
   resume evidence must remain unknown. Test a complete fake-Pi/Manager roundtrip
   yielding a trace which replay can consume, including incomplete outcomes.
2. **Exact live identity and bounds.** The CLI currently trusts a caller-provided
   config fingerprint, accepts arbitrary base refs and unbounded/nonfinite poll
   timeouts, and initializes Manager before validating all selected tasks. Pin
   actual effective nonsecret runtime configuration/defaults and submission
   payload, reject invalid/duplicate/oversized selections and non-SHA committed
   refs before side effects. Changed defaults under a stable run ID must reject.
   All task waits and the total run must have documented finite limits.
3. **Durable private run state.** A plain `wx` lock survives a crashed process;
   state reads are unbounded and follow symlinks, and the predictable `.tmp`
   write can overwrite an existing target. Use existing ownership/locking
   primitives and bounded validated private state with exclusive atomic writes.
   Prove lost-response reconciliation, simultaneous callers and crash recovery.
   Do not widen runtime/global permissions or modify shared host state.
4. **Report comparison.** Raw JSON reports currently enter compare without a
   schema, observed trace coverage may differ silently, duplicate/missing perTask
   IDs are not rejected, and numeric candidate-minus-baseline deltas are absent.
   Validate supported report versions/shapes/provenance, exact selected and
   observed coverage by default, explicit missing coverage and matched-observation
   denominators, and actual numeric deltas. Reject same-report-origin claims
   that conflict with trace provenance. Synthetic comparisons stay labelled.
5. **Grading boundaries.** Check duplicate/unknown selections, unknown/unselected
   traces, contradictory changed/unchanged path evidence and unsupported criteria.
   An independent review must have a different reviewJobId. Missing selected tasks
   must remain in all relevant metric coverage counts. Required unknown criteria
   cannot pass; distinguish observed file loss from unavailable file evidence.
6. **Constructed bounded output.** `buildReport` currently inserts arbitrary
   `result` unchanged despite its allowlist claim, and `writeReport` has no byte
   bound. Recompute/validate a constructed result and enforce output bounds before
   creating a destination. Reject malformed/symlinked/unbounded inputs without
   printing raw Manager/config errors or private content. Keep offline imports
   independent of Manager/config initialization.

## Verification requirements

Add focused node:test regressions for the defects above and execute RED/GREEN on
gram. The initial file-load RED at `f016d13` is valid evidence that the new module
was absent, not evidence that later strengthened assertions individually failed.
Record exact source SHA and commands; collect full actual outputs before claiming
success. Parent and an independent native Astra reviewer must approve the final
committed implementation. No unresolved blocker is accepted as complete.

## Independent review at `9d37008`

Native Astra reviewed the committed correction checkpoint and found five P2
blockers. The 55/55 focused run and deterministic replay are checkpoint evidence,
not approval of the final evaluator:

1. Saved reports can assert success alongside failed criteria, or attach
   measurements to missing outcomes. Validate derived success, fixed categorical
   and reason values, missing-outcome invariants and every per-task aggregate.
   Preserve explicit applicability when an outcome is absent.
2. A caller-selected fresh state directory can forget run identity while Manager
   reuses the old request ID under changed configured defaults. Bind each run to
   a canonical Manager-owned registry and lock independent of that directory.
3. Deletion counts as a change but cannot prove a required artifact exists.
   Preserve deletion evidence for file-retention checks and separately establish
   required-artifact presence.
4. Execution failure alone does not prove a file constraint was lost. Grade
   preservation independently from execution status; unavailable evidence is
   unknown and overall task success remains false.
5. CLI malformed-JSON and enum errors can echo input content. Emit bounded generic
   errors and prove private sentinel values never appear on stdout/stderr.

Explicit task-success count/rate deltas are a small usability improvement, not an
additional blocker. Remove the minor extra EOF blank line in the incomplete
fixture. A dedicated Sol correction unit owns these changes; Astra must review
the resulting committed checkpoint and focused evidence before closure.
