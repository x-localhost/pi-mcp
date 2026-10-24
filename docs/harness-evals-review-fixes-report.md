# Evaluation review fixes — 2026-10-24

Worktree: `/Users/leebw/workspace/claude/pi-mcp-worktrees/evaluation-review-fixes` on `codex/evaluation/review-fixes`, committed input `9d370081e3c4f64b3c408cbdde23da8848162719`. Root, branch, HEAD and clean starting status were verified before edits. This unit remains uncommitted for parent review.

## Changes

- `evals/report.mjs` derives task success, criterion categories, applicability, categorical totals and numeric means from bounded per-task rows; missing outcomes cannot carry success or measurements. This is consistency validation, not authentication of a self-consistent forged report.
- `evals/live-adapter.mjs` records run identity beneath the configured Manager `stateDir/evaluation-runs`, regardless of caller `stateDir`, retaining Manager request-ID recovery and tombstones. It exports changed deletion paths separately from required regular-file presence checked against the immutable code snapshot.
- `evals/schema.mjs`, `evals/grader.mjs`, and synthetic fixtures add `artifacts.presentPaths`; required absent/unknown files cannot pass, while failed execution can still report independently proven file preservation.
- `scripts/evaluate-harness.mjs` bounds/sanitizes CLI diagnostics and refuses a dirty executable evaluation checkout before Manager initialization.
- `docs/harness-evals.md` documents the evidence, canonical state location and clean-checkout behavior. The incomplete fixture's extra EOF blank line was removed. Existing tests were updated for the new evidence field and state path; `test/harness-evals-review-fixes.test.mjs` adds focused regressions.

## Test chronology and commands

All Node tests ran on `ssh gram`, image `pi-harness-evaluation:20261024`, network disabled, 2 CPUs/2 GiB, UID 1001, task root `/tmp/pi-harness-evaluation-review-fixes-20261024`. The source was copied with:

```sh
tar --no-xattrs -cf - src test internal-agent scripts docs examples evals package.json package-lock.json | ssh gram 'tar -xf - -C /tmp/pi-harness-evaluation-review-fixes-20261024/app'
```

The first focused RED used this exact Docker/test invocation (subsequent runs changed only the container name, test selector and log filename):

```sh
ssh gram "docker run --rm --name pi-eval-review-red --network none --cpus 2 --memory 2g --user 1001:1001 -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/src:/app/src -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/test:/app/test -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/evals:/app/evals -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/scripts:/app/scripts -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/internal-agent:/app/internal-agent -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/docs:/app/docs -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/examples:/app/examples -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/package.json:/app/package.json -w /app pi-harness-evaluation:20261024 node --test test/harness-evals-review-fixes.test.mjs > /tmp/pi-harness-evaluation-review-fixes-20261024/red.log 2>&1"
```

Initial RED: 6 tests, 1 pass and 5 fail. The apparently passing state-dir case used the wrong call order, so it was not a product pass. After correcting its order, `node --test --test-name-pattern='alternate caller stateDir' test/harness-evals-review-fixes.test.mjs` on the same Docker mounts yielded 0 pass / 1 fail (`Missing expected rejection`). After the five fixes, the first consolidated run `node --test test/harness-evals-review-fixes.test.mjs test/harness-evals-corrections.test.mjs test/harness-evals.test.mjs` yielded 59 pass / 2 fail; both failures were old assertions coupling retention to execution status. They were updated to assert completion and file-preservation dimensions separately.

The extra committed-source guard was added after the five fixes. Its focused RED used `node --test --test-name-pattern='dirty evaluator' test/harness-evals-review-fixes.test.mjs` with the same mounts and yielded 0 pass / 1 fail: the dirty CLI exited 0. Config/Manager error leakage, invalid status, and applicability assertions were added after implementation; they are regression coverage, not separate before-fix RED cycles.

Final command:

```sh
ssh gram "docker run --rm --name pi-eval-review-final --network none --cpus 2 --memory 2g --user 1001:1001 -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/src:/app/src -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/test:/app/test -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/evals:/app/evals -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/scripts:/app/scripts -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/internal-agent:/app/internal-agent -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/docs:/app/docs -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/examples:/app/examples -v /tmp/pi-harness-evaluation-review-fixes-20261024/app/package.json:/app/package.json -w /app pi-harness-evaluation:20261024 node --test test/harness-evals-review-fixes.test.mjs test/harness-evals-corrections.test.mjs test/harness-evals.test.mjs > /tmp/pi-harness-evaluation-review-fixes-20261024/final-focused.log 2>&1"
```

Observed final result: 62 pass, 0 fail/skip/cancel, 13.05 s. The fake-Pi configured CLI live → bundle → offline replay test passed with no provider/network endpoint. `git diff --check` passed locally. Remote evidence logs: `red.log`, `dirty-red.log`, `green1.log`, `green2.log`, and `final-focused.log` under the task root. Parent owns full-suite regression and final independent review after commit.

## Limits

`--state-dir` remains a required compatibility argument but does not control the Manager-owned identity registry. Reports are self-consistent but have no cryptographic origin authentication. Live resume evidence remains unknown when Manager lacks complete request-to-job events. File retention is a file-preservation predicate only. No real model, paid or company endpoint was called.
