# Harness evaluation suite

A small, versioned, offline-first evaluation harness for the pi-mcp coding
agent harness itself. It is a **grader/harness validation tool**, not a
model-capability benchmark: offline grading only checks that a candidate's
own claimed evidence is internally consistent (same job, same code digest,
same contract, no gaps hidden by truncation), never whether that evidence is
authentic. See `docs/evaluation-plan.md` for the approved design contract.

## Layout

- `evals/errors.mjs` -- `SchemaError` (malformed input) and `ProvenanceError`
  (well-formed but incompatible/mismatched identity).
- `evals/util.mjs` -- `sha256Hex`, `stableStringify`, and the three identifier
  patterns used throughout: `GIT_SHA` (40-hex commit ids), `HEX64` (64-hex
  SHA-256 content digests), `CONFIG_FINGERPRINT_PATTERN` (`sha256:<64-hex>`).
- `evals/schema.mjs` -- `parseTask`, `parseTrace`, `parseTraceBatch`,
  `taskContractDigest`, `taskContentDigest`.
- `evals/suite.mjs` -- `loadSuite()`, backed by `evals/suite/v1/tasks.json`
  (10 immutable tasks, one per required scenario).
- `evals/grader.mjs` -- `gradeTask`, `gradeSuite`, `GRADER_VERSION`. Pure
  functions: no ambient time, randomness, filesystem or network access.
- `evals/report.mjs` -- `buildReport`, `writeReport` (owner-private `0600`,
  never overwrites an existing file).
- `evals/compare.mjs` -- `compareReports`.
- `evals/live-adapter.mjs` -- `submitLiveRun`, `pollLiveRun` (uses an
  injected Manager-shaped object; never imports `src/manager.mjs` itself).
- `evals/fixtures/synthetic-baseline.mjs`, `evals/fixtures/synthetic-regressed.mjs`
  -- synthetic positive/negative replay fixtures for grader/CLI validation.
- `scripts/evaluate-harness.mjs` -- the CLI (`replay`, `compare`, `live`).

## Identity fields, precisely

Two unrelated identifier families appear throughout; do not confuse them:

- **Git commit ids** (`harnessCommit`, `taskBaseCommit`): 40 lowercase hex
  characters (SHA-1). `harnessCommit` is this evaluation code's own commit;
  `taskBaseCommit` is the task repository's base commit. They are allowed,
  and expected, to differ, and a comparison never requires them to match.
- **Content digests** (`codeDigest`, `contractDigest`, the hex part of
  `configFingerprint`): 64 lowercase hex characters (SHA-256).

A task's `contractDigest` (`taskContractDigest(task)`) is always computed by
the grader from the task's own `expectedEvidence` fields
(`changedPaths`, `requiredVerifierIds`, `requiresReview`,
`requiredConstraintIds`) -- never trusted from a candidate's self-reported
value. Verification/review evidence is only accepted when its `jobId`
matches `execution.jobId`, its `codeDigest` matches `execution.codeDigest`,
and its `contractDigest` matches this independently recomputed value.

## CLI

### `replay` (fully offline; no Manager, no config, no credentials)

```
node scripts/evaluate-harness.mjs replay \
  --fixture baseline \
  --harness-commit "$(node -e "process.stdout.write('1'.repeat(40))")" \
  --task-base-commit "$(node -e "process.stdout.write('2'.repeat(40))")" \
  --config-fingerprint "sha256:$(node -e "process.stdout.write('3'.repeat(64))")" \
  [--select task-a,task-b] [--out /absolute/path/report.json]
```

(The `--fixture baseline`/`regressed` fixtures embed exactly these three
values -- `'1'.repeat(40)`, `'2'.repeat(40)`, `sha256:` + `'3'.repeat(64)` --
as their `harnessCommit`/`taskBaseCommit`/`configFingerprint`; `replay`
rejects a fixture whose embedded provenance does not match the `--harness-commit`/
`--task-base-commit`/`--config-fingerprint` you pass, so these three flags must
match exactly when replaying the bundled fixtures.)

`--fixture baseline|regressed` replays the bundled synthetic fixtures
(labelled `synthetic`, for grader validation only). `--traces <path>`
replays an arbitrary bounded (≤5MB) JSON array of raw trace records instead.
Without `--select`, every suite task is selected (missing outcomes for any
unselected-but-not-provided task are graded failures, not silently
dropped). Without `--out`, the report JSON is printed to stdout; with
`--out`, it is written owner-private (`0600`) and the write refuses to
overwrite an existing file.

### `compare`

```
node scripts/evaluate-harness.mjs compare --baseline base.json --candidate candidate.json [--allow-selection-mismatch]
```

Refuses, by default, to compare reports with a different suite digest,
grader version, config fingerprint, origin, or task selection (naming the
missing coverage). `harnessCommit`/`taskBaseCommit` are never compared --
source commits may differ intentionally. Latency/cost deltas use only
matched, observed cases and report the matched count alongside any
changed-task (regressed/fixed) list.

### `live` (explicit opt-in; the only subcommand that touches a real Manager)

```
node scripts/evaluate-harness.mjs live --live --ack I-UNDERSTAND-THIS-SUBMITS-TO-THE-CONFIGURED-PI-MCP-MANAGER \
  --run-id my-eval-run-1 --select fix-null-check,resume-after-timeout \
  --repository /abs/path/to/repo --base-commit <committed-sha> \
  --config-fingerprint sha256:<64-hex> --state-dir /abs/path/to/private/state \
  [--config /path/to/pi-mcp-config.json] [--provider p] [--model m] [--poll-timeout-ms 30000]
```

Both `--live` and the exact `--ack` token are required before *anything*
else happens; `replay`/`compare` never import Manager/config at all, and
`live` only imports them dynamically, after this guard passes. The run's
identity (suite digest, task selection, repository, base commit, config
fingerprint) and each task's own content are pinned to `--run-id`: a retried
or restarted submission with the same run-id and the same inputs reconciles
to the same Manager job (idempotent, crash-safe); a changed config, task
selection or task content under the same run-id is rejected before the
Manager is contacted. The adapter never auto-approves, attests review, or
commits anything, and returns only a small allowlisted evidence object
(`runId`, `taskId`, `jobId`, `requestId`, `status`, `origin`) -- never the
full Manager job record.

The CLI's own `live` wiring (loading `src/config.mjs` + `src/manager.mjs`)
is intentionally thin and is not covered by this unit's automated tests,
which would otherwise require a real pi-mcp configuration/credentials. The
adapter logic itself (`evals/live-adapter.mjs`) is fully covered using the
project's own established "fake Manager" pattern: a real `Manager` instance
constructed with `piPath: '/bin/true'` and `spawnWorker: false`, so no real
Pi process, network or paid provider is ever touched.

## Suite content

`evals/suite/v1/tasks.json` has exactly one task per required scenario:
`successful_completion`, `false_completion`, `lost_constraint`,
`duplicate_resume`, `repeated_resume`, `stale_verification`, `stale_review`,
`missing_outcome` (demonstrated by omitting its trace from a fixture, not by
any special task field), `unavailable_usage`, `event_gap_resume`.

## Known limitations

- `scripts/evaluate-harness.mjs live` is exercised only by manual/integration
  use against a real configured Manager; it is not covered by an automated
  test in this unit (see above).
- `compareReports`'s latency/cost delta is an unweighted mean over matched
  observed per-task values, not a statistically rigorous estimator.
- The suite is intentionally small (10 tasks); it validates the grader and
  harness plumbing, not broad model behavior coverage.
