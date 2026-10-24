# Evaluation corrections unit report — 2026-10-24

Worktree: `/Users/leebw/workspace/claude/pi-mcp-worktrees/evaluation-corrections`
Branch/base: `codex/evaluation/corrections` at committed `1c27ed55fc1f64b63443579992b7a4e4e1166bf4`.
The unit remains uncommitted for parent review. No production `src/` file, global setting, live MCP, paid endpoint or external service was changed.

## Changed files

- `evals/schema.mjs`: strict supported criteria and path predicates; runtime canonical acceptance digest; nullable unknown artifact/retention evidence; distinct review job.
- `evals/grader.mjs`: required unknown cannot pass; selected/observed scope checks; missing outcomes enter metric coverage.
- `evals/live-adapter.mjs`: exact config/task/payload run identity; required verifier and acceptance submission; Linux ownership lock and bounded private state; real Manager evidence to replayable traces; request/base/contract checks; deleted/redacted paths handled conservatively; finite poll.
- `evals/report.mjs` and `evals/compare.mjs`: reconstructed bounded reports, supported shape/provenance, exact selected and observed coverage by default, matched numeric deltas.
- `scripts/evaluate-harness.mjs`: strict flags and safe bounded input, pre-Manager selection/commit checks, finite total/per-task time, live trace bundle, redacted live errors, offline replay/compare imports.
- `evals/fixtures/synthetic-incomplete.mjs`: explicit observed incomplete execution fixture.
- `test/harness-evals-corrections.test.mjs`: defect regressions and fake-Pi Manager/CLI integration.
- `test/harness-evals.test.mjs`: correct comparison fixture provenance, canonical suite digests and live API expectations.
- `docs/harness-evals.md`: updated commands, evidence limits and measured scope.
- This report, `docs/harness-evals-corrections-report.md`.

## Remote test evidence

All Node tests ran on `ssh gram` in task root
`/tmp/pi-harness-evaluation-corrections-20261024` using image
`pi-harness-evaluation:20261024` with `--network none --cpus 2 --memory 2g --user 1001:1001`,
no ports or credentials. Source was transferred with:

`tar --no-xattrs -cf - src test internal-agent scripts docs examples evals package.json package-lock.json | ssh gram 'tar -xf - -C /tmp/pi-harness-evaluation-corrections-20261024/app'`

Later incremental runs transferred `evals test scripts docs` with the same tar command.
The Docker mount set was:

`-v /tmp/pi-harness-evaluation-corrections-20261024/app/src:/app/src -v /tmp/pi-harness-evaluation-corrections-20261024/app/test:/app/test -v /tmp/pi-harness-evaluation-corrections-20261024/app/evals:/app/evals -v /tmp/pi-harness-evaluation-corrections-20261024/app/scripts:/app/scripts -v /tmp/pi-harness-evaluation-corrections-20261024/app/internal-agent:/app/internal-agent -v /tmp/pi-harness-evaluation-corrections-20261024/app/docs:/app/docs -v /tmp/pi-harness-evaluation-corrections-20261024/app/examples:/app/examples -v /tmp/pi-harness-evaluation-corrections-20261024/app/package.json:/app/package.json`.

Exact final remote invocation (the preceding transfer copied the current tree):

```sh
ssh gram "docker run --rm --name pi-eval-corrections-final2 --network none --cpus 2 --memory 2g --user 1001:1001 -v /tmp/pi-harness-evaluation-corrections-20261024/app/src:/app/src -v /tmp/pi-harness-evaluation-corrections-20261024/app/test:/app/test -v /tmp/pi-harness-evaluation-corrections-20261024/app/evals:/app/evals -v /tmp/pi-harness-evaluation-corrections-20261024/app/scripts:/app/scripts -v /tmp/pi-harness-evaluation-corrections-20261024/app/internal-agent:/app/internal-agent -v /tmp/pi-harness-evaluation-corrections-20261024/app/docs:/app/docs -v /tmp/pi-harness-evaluation-corrections-20261024/app/examples:/app/examples -v /tmp/pi-harness-evaluation-corrections-20261024/app/package.json:/app/package.json -w /app pi-harness-evaluation:20261024 node --test test/harness-evals.test.mjs test/harness-evals-corrections.test.mjs > /tmp/pi-harness-evaluation-corrections-20261024/final-focused2.log 2>&1; result=\$?; tail -32 /tmp/pi-harness-evaluation-corrections-20261024/final-focused2.log; exit \$result"
```

RED/GREEN order and actual observations:

1. Initial five focused regressions were written before schema/report/CLI/live fixes. Remote command: `docker run --rm --name pi-eval-corrections-red --network none --cpus 2 --memory 2g --user 1001:1001 <mount set above> -w /app pi-harness-evaluation:20261024 node --test test/harness-evals-corrections.test.mjs`. Result: 0 passed, 5 failed, 392 ms. Failures were runtime contract digest mismatch, unknown artifact schema rejection, raw result leakage, permissive CLI flags and live admission side effects. Full output: `/tmp/pi-harness-evaluation-corrections-20261024/red.log`.
2. Crash-stale lock/lost-response and actual Manager/fake-Pi trace tests were added before replacing the live adapter. Remote `node --test --test-name-pattern='crash-stale|actual fake Pi' test/harness-evals-corrections.test.mjs` under the same Docker mounts/name `pi-eval-corrections-red4`: 0 passed, 2 failed. Old lock timed out; poll had no trace. The first setup attempt `red3` also failed 0/2, but its stale-lock assertion had incorrectly assumed a lock file survived normal cleanup; that test setup was corrected before `red4`.
3. After the live implementation, `node --test --test-name-pattern='live binds|crash-stale|actual fake Pi' test/harness-evals-corrections.test.mjs` under container `pi-eval-corrections-green1` passed 3/3 (4.1 s).
4. Parent-requested config namespace, trace relabeling, and deletion regressions were added after the main live implementation but before those specific edge fixes. `node --test --test-name-pattern='effective identity|trace cannot relabel|deleted source' test/harness-evals-corrections.test.mjs` under `pi-eval-corrections-edge-red` failed 0/3. The three subsequent fixes made these green.
   A further committed-harness-SHA identity regression was added before its fix: `node --test --test-name-pattern='same run ID cannot' test/harness-evals-corrections.test.mjs` under `pi-eval-commit-red` failed 0/1 because the old run identity allowed the changed source SHA.
5. The explicit incomplete fixture and actual copied-checkout CLI live→bundle→offline replay test were added after the relevant implementation. They are regression/integration tests, not claimed as pre-fix RED. The CLI-only `node --test --test-name-pattern='CLI live fake-Pi bundle' test/harness-evals-corrections.test.mjs` under `pi-eval-cli-roundtrip` passed 1/1 (3.0 s).
6. Consolidated command: `ssh gram "docker run --rm --name pi-eval-corrections-final2 --network none --cpus 2 --memory 2g --user 1001:1001 <mount set above> -w /app pi-harness-evaluation:20261024 node --test test/harness-evals.test.mjs test/harness-evals-corrections.test.mjs > /tmp/pi-harness-evaluation-corrections-20261024/final-focused2.log 2>&1"`. Observed 55 passed, 0 failed, 0 skipped/cancelled, 8327 ms. Full log: `/tmp/pi-harness-evaluation-corrections-20261024/final-focused2.log`.
7. Quick local `git diff --check` passed. No local suite/build/install was run.

## Limits for review

The live trace is evidence consistency, not independent authentication of a caller attestation. A file-preservation result checks immutable source paths only. Manager events do not currently give a complete request-to-job mapping, so required live resume evidence remains unknown even when a single submission succeeds; event gaps are retained. Config identity hashes normalized nonsecret settings and paths, not mutable external model/auth/agent file contents. The ten suite tasks need a matching supplied repository and declared verifiers; the fake-Pi CLI run proves wiring and replay, not broad model quality. No full repository suite was run by this unit; parent will do final committed regression and independent review.
