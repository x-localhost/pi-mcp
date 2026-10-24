# Harness evaluation verification — 2026-10-24

Final result: **384/384 tests passed**, evaluator-focused **62/62**, independent
Astra source review approved. Synthetic replay, byte-identical repeat, regression
comparison and fake-Pi live-to-replay integration passed. The measured scope is
evaluator/harness correctness; no real model task-solving score is claimed.
Final committed test source: `27c5eb2`. Earlier failed checkpoints remain below.

## Scope and provenance

Main base `edff46ff3ca260a73cf8e6a6166d6080ca484b80`; prior executable
harness source `661a898e715ac16eb80224b880a3be8c7371cd93`.
Integration branch `codex/evaluation/integration`, worktree
`/Users/leebw/workspace/claude/pi-mcp-worktrees/evaluation`.
The approved contract and independent Astra design review are in
[evaluation-plan.md](evaluation-plan.md). Synthetic replay validates the grader's
handling of supplied evidence; it does not measure agent/model task performance.
No corporate or paid model endpoint is used by evaluation commands or tests.

## Delegation and permissions

The original Sonnet5 job `task-834e646b-d1c9-4531-949f-437df7ae20a8` was
resumed in its original worktree after the user's instruction to proceed. Its
historical bridge base remains `50a55ce`; the parent first fast-forwarded its clean
worktree to the new committed plan `9acd63b`. Changes are reviewed against that
actual input, not the bridge's historical broad diff.

A short-lived stdio connection to the same installed bridge used its supported
`CLAUDE_DELEGATE_CONFIG` override. A private task configuration added five exact
worktree-scoped read-only Git identity/status/ancestor commands. Model, allowed
roots, restricted/dontAsk mode and existing denies stayed unchanged. No shared
MCP restart or live/global settings edit occurred. Live bridge configuration
SHA256 before work: `243ce60a6ac364e364e241e49b2b9ff38727fecbe3e393959872d4212b4dcb43`,
mode `0644`. After all bridge jobs ended, parent verified the same hash and mode,
retained `evidence/permission-manifest.json` on gram and removed the private task
configuration, client and prompts. No shared connection restart was needed.

- RED job `task-c3ee192d-a9fe-48f0-9870-5596b7babf6c`: exact
  `claude-sonnet-5` identity observed; terminal completed, tests only. Two
  unnecessary commands (`echo $?`, task-worktree `git diff --stat`) were denied.
  The worker did not stop/report accurately; parent inspected the event log,
  rejected that reporting and instructed it to omit these operations entirely.
  No permission was broadened and no alternative was used for the denied calls.
- GREEN job `task-69d89e1b-3d1c-4731-9cf1-31c6c845cd3e`: stopped without writes
  after attempting an unapproved optional ancestry command against main. The
  parent removed this auxiliary check from the unit; it was not retried or
  performed by another route. Root, branch, exact HEAD and status already
  matched the supplied committed input. No new permission was granted.
  Continuation `task-25710c18-f17c-4e05-a51b-8cf9c6692fe8` completed, exact
  Sonnet5 identity confirmed, zero permission denials. It self-reported one
  unnecessary `true` command outside the scoped command list; no side effects.
  Parent corrected its inaccurate claim that strengthened tests preceded code: the
  original RED did, but the later42-case strengthening followed the modules. The parent
  committed RED tests at `f016d1349898ea5f553b34919141a345c9b5250e` and requested
  the agreed job/code/contract binding, per-dimension usage, CLI and retry tests
  before implementation. Only four exact approved root/branch/HEAD/status commands may use Bash;
  parent owns remote execution, diff review and commits.
- Before GREEN: native reviewers/previous workers completed; bridge health
  authenticated, allowed roots unchanged, activeJobs=0. No recursive delegation.

## Remote checks

All builds and test execution use gram, task root
`/tmp/pi-harness-evaluation-20261024`. The Mac only coordinates agents, Git,
file edits and transfer. Node `24.22.0-bookworm` and pinned project dependencies
were built from the production Dockerfile as `pi-harness-evaluation:20261024`,
image `sha256:7fcc16542bf77f822247fe72976bcec1035ace7ce3de12083f1edb683290a1e5`.
The build used plan source `5d8b2b0`, whose executable runtime equals main.
Test/replay source is mounted separately at each recorded committed checkpoint.

Initial RED (2026-10-24): `node --test /app/test/harness-evals.test.mjs`, in a
fresh disposable Docker container, network none, UID0, 2 CPUs, 2 GiB, PID limit256.
Observed exit1, `ERR_MODULE_NOT_FOUND` for `/app/evals/errors.mjs`: the new feature
module is absent. Pass0/fail1 is the test-file load result, not 23 individually
executed assertions. Log `evidence/red.log`. Parent reviewed and committed the
single test file; no implementation existed at this point.

Initial GREEN candidate (uncommitted working snapshot while Sonnet completed
documentation): mounted evals/, scripts/ and test/ from its worktree.
`timeout120s node --test /app/test/harness-evals.test.mjs` observed **41/42 passed**,
1 failed, 0 skipped/cancelled; 2406.468ms. The failing comparison test changes
report metadata without changing the supplied trace metadata, correctly tripping
the provenance check. Log `evidence/initial-green.log`. No final success claim.

[Parent review](evaluation-review.md) records additional implementation gaps
requiring corrective regression tests. Final committed replay/compare, independent
review, integration and cleanup are pending.

## Corrective handoff

Reviewed initial candidate committed as `0644560` in the bridge worktree and
cherry-picked as `1c27ed5` on the integration branch; main remains untouched.
The initial candidate is intentionally not marked ready. Native GPT-6 Sol
`/root/harness_runtime` owns the isolated corrective worktree at this committed
base and is adding targeted RED regressions for the six parent review findings.
Substantial schema/transaction/concurrency corrections prompted this routing;
there is no outstanding bridge permission blocker and no denied operation is
being executed by another route. Parent owns final remote replay/regression and
native Astra owns independent review of the corrected committed source.

Targeted corrective RED used base `1c27ed5` with new test-only assertions on gram:
`node --test test/harness-evals-corrections.test.mjs`, in the pinned image with
network disabled and task-specific mounts. Observed **0/5 passed, 5 failed**:
runtime contract digest, unavailable artifact evidence, arbitrary result leakage,
unknown CLI flag and live identity checks. Log:
`/tmp/pi-harness-evaluation-corrections-20261024/red.log`. These are actual
before-fix failures; final GREEN and later test additions must be recorded
separately.

An additional before-fix run selected
`--test-name-pattern='crash-stale|actual fake Pi'` in the same corrective test
file. Observed **0/2 passed, 2 failed**: stale run locking blocked recovery, and
the real Manager/fake-Pi result had no replayable trace. These failures preceded
the corresponding state/evidence implementation changes.

## Committed checkpoint `9d37008`

Sol's first corrective unit was committed as `edb4694` and integrated as
`8c2f643`; subsequent plan-only checkpoint `9d370081e3c4f64b3c408cbdde23da8848162719`
has tree `7140d11cb97c2f6a868b8d8083b464c7f26481a6`. Its focused gram suite passed
55/55, no failures/skips/cancellations, 8326.66883ms. This includes the configured
fake-Pi CLI live bundle and offline replay. The [unit report](harness-evals-corrections-report.md)
separates before-fix RED runs from later integration test additions.

Parent transferred the exact committed Git archive to gram and ran all tests in
the pinned image with network none, UID0, 2 CPUs, 2GiB and PID limit512. Runtime,
internal-agent and package/lock files are unchanged from the main base. The
packaged approved-MCP fixture was copied to `/app/approved-mcp/mock.mjs`, linked
at `/app/approved-mcp/link`, and made root-owned 0555 for these disposable tests.
Command: `timeout 540s node --test --test-concurrency=1 test/*.test.mjs`.
Observed **377/377**, 15 suites, failed/cancelled/skipped0, exit0,
271423.535085ms. The exact Docker command is retained as `run-full-regression.sh`.

Parent replayed baseline, regressed and incomplete synthetic fixtures through the
CLI, repeated baseline byte-for-byte with `cmp`, then compared baseline against
regressed. A separate inspection script asserted each expected failure category:

- Baseline: 3/10 successful, 9 observed and 1 missing outcome. The seven
  unsuccessful cases are intentional negative/unknown fixtures.
- Regressed: 2/10; only `fix-null-check` changes from success to unsuccessful.
  Incomplete: 2/10, with an explicit observed `execution_incomplete` outcome.
- File preservation: retained1/lost1 of2; submission idempotency:
  correct1/incorrect1/unknown1 of3.
- Synthetic latency/tokens/cost: 8 observed and 2 unknown of10; means4200ms,
  1200tokens and USD0.02 are fixture constants, not provider measurements.
  Matched comparison coverage8 and numerical deltas0 for these fixed values.
- Repeated baseline JSON is identical. Output reports are 0600 and were created
  exclusively. Fixture commits `111…`/`222…` and fingerprint `333…` are explicitly
  synthetic placeholders; executed grader provenance is the committed source above.

Evidence was preserved under
`/tmp/pi-harness-evaluation-final-20261024/evidence/checkpoint-9d37008` (reports,
summary, commands, inspection script, regression log/exit and source/image metadata).

Independent Astra review did **not** approve this checkpoint: five evaluator
correctness gaps remain, described in [evaluation-review.md](evaluation-review.md).
The complete suite pass does not establish coverage of those newly found cases.
A dedicated Sol review-fixes unit is adding the missing RED regressions; final
review, committed verification and main integration remain pending.

## Review closure and readiness regression at `73c42f7`

Sol's final evaluator unit `f8a7929` was integrated as
`acd9d63a680283eed8006a2e4afd313851126b1e`, with plan-only checkpoint
`73c42f7054810aba626ea2d3f26236210d6b8199` (tree
`87312e9db7191a1a47fa0367c46e73d500929a76`). The focused suite passed **62/62**,
no fail/skip/cancel, 13053.900422ms. The [review-fixes unit report](harness-evals-review-fixes-report.md)
records before-fix failures separately from regression tests added after code.
Independent native Astra approved all five findings and the additional dirty-code
guard at this exact source, subject to the parent's complete regression.

Parent replay, comparison, byte-identical baseline repeat and independent result
inspection all passed again with the same expected synthetic outcomes listed
above. However, the full suite returned **383/384**, 15 suites, fail1,
cancelled/skipped0, exit1, 283182.839135ms. The existing
`real Pi drops a complete two-tool group and observation omits raw call data`
test failed at `test/harness-context.test.mjs:83` while parsing the readiness
file, before any task prompt. The file can briefly exist with an incomplete JSON
write. The production worker already retries parsing; four test polling sites
caught read errors but let parse errors escape. This is retained as an actual
failed checkpoint, not replaced by a passing rerun.

Parent made the four-line test-only correction in isolated readiness worktree
at base `73c42f7`, committed as `d95ca5b`. The deadline and final assertions are
unchanged, and persistent invalid readiness still fails. No runtime change was
needed. A separate paid review was unnecessary for this small correction.
Command in the same pinned image: `timeout 90s node --test --test-concurrency=1
test/harness-context.test.mjs test/real-approved-mcp.test.mjs`. Five runs each
passed **6/6**, fail/cancel/skip0, exit0; durations 9547.870614, 9737.767936,
10241.330375, 9454.348815 and 9585.152458ms. Their exact Docker script and logs
are under the readiness evidence root. The failed checkpoint's complete reports,
commands, metadata and regression log are preserved as `checkpoint-73c42f7`.

## Final committed verification at `27c5eb2`

The readiness correction was integrated as
`27c5eb22bcb18b6f0f2d88c891ff52ffdde8faa1`, tree
`ae6d38dfb8c78cb8b8264e6d9a2b74657c34c31c`. The evaluator's executable changes
remain `acd9d63`; subsequent changes are the four readiness-test lines and
coordination documents. Production `src/`, `internal-agent/`, package manifests
and lockfile are identical to the main base. Parent reviewed the correction and
`git diff --check` passed. Astra's approval at `73c42f7` therefore still covers
the identical evaluator implementation; the parent reviewed the trivial test fix.

Parent transferred `git archive 27c5eb22bcb18b6f0f2d88c891ff52ffdde8faa1` to the
isolated final root and repeated the exact pinned-image replay and full suite.
`timeout 540s node --test --test-concurrency=1 test/*.test.mjs` passed **384/384**,
15 suites, failed/cancelled/skipped/todo0, exit0, **257310.363567ms**. Runtime
and dependency image identity are recorded above; changed source and tests were
mounted from this committed archive. No local test/build/install/service ran.

Baseline, regressed and incomplete replay results, deterministic repetition and
comparison all passed at the final source. Expected fixture task scores remain
3/10, 2/10 and 2/10 respectively, with only `fix-null-check` changed by the
regressed fixture. Intentional negative/unknown cases explain the other baseline
outcomes. These percentages are **not model task-solving success rates**. Fixture
provenance placeholders describe supplied traces; the executed grader's actual
Git source is recorded separately in `final-metadata.json`.

## Evidence, cleanup and remaining scope

Consolidated private evidence on gram:
`/tmp/pi-harness-evaluation-evidence-20261024` — **69 files including the checksum
manifest**, 0700 directories and 0600 files. It includes initial RED/failed GREEN,
both Sol units, five readiness repetitions, intermediate checkpoints, final
reports, exact replay/regression scripts, source/image metadata and cleanup report.
Every final evidence file was compared byte-for-byte before deleting its source;
the consolidated SHA256 manifest was verified before cleanup and regenerated to
include the cleanup report. Historical unit paths above identify where commands
ran; their logs now live in this consolidated evidence directory.

All five task source/build directories and the evaluation image tag were removed
after confirming no container referenced the task image. Shared Docker build
cache and unrelated resources were untouched. Prior harness evidence remains
unchanged (18 files, checked by hash). Local source/review worktrees are retained.
Private temporary bridge files were removed and the live bridge config still
has its original SHA256 and 0644 mode. No live MCP/global settings, push,
publication, deployment or paid/corporate model endpoint was changed or invoked.

Evaluation implementation, offline evaluation and review are complete. Local main
integration uses a final clean-checkout check and fast-forward only, after scoped
documentation and a separate root handoff commit. No evaluator blocker remains.
Actual model performance remains unmeasured: the ten bundled tasks are illustrative,
and a matching task repository, verifiers and authorized provider are prerequisites
for live model benchmarking. Caller-supplied evidence is checked for consistency,
not cryptographic authenticity; file preservation and submission idempotency do
not establish full API/instruction or session semantics. Missing evidence remains
unknown. External model/auth/agent file contents must be pinned separately if
their mutability matters to a later live comparison.
