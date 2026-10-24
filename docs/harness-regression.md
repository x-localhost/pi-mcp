# Harness integration verification — 2026-10-24

## Source and review

Original clean main: `52a13358c175950b12dec31f1eb5f0f421129cc2`.
Final executable source: `661a898e715ac16eb80224b880a3be8c7371cd93` on
`codex/harness/integration`. Subsequent integration records and handoff changes
are documentation only. Existing unrelated worktrees were preserved.

GPT-6 Astra led design, reviewed delegated diffs, made scoped commits, integrated
serially and ran the final remote regression. Native Luna handled the small
policy/storage unit; native Sol handled runtime, tools, workflow and corrections.
An independent native Astra reviewer approved the final source after its runtime,
workflow and mixed-content findings were corrected. The native thread limit
prevented reactivating a separate Sol tester; the parent performed the remote
regression instead. This is not reported as an independent Sol test run.

## Delivered behavior

- Reject file URI paths before authorization and count repository symlinks without
  following their targets during storage admission.
- Initialize active approved MCP servers concurrently under one bounded startup
  budget; retain separate normal tool-call deadlines and close failed transports.
- Inherit versioned acceptance and selected verifiers across continuations. Bind
  verification, source artifacts and explicit review verdicts to code/contract
  digests. Validate declared packaged grader files before and after execution.
- Start independent read-only reviews from immutable code with a fresh session.
  Approval/rejection and idempotent receipts do not treat model prose as approval.
- Bound provider context while retaining every user instruction and coherent tool
  groups, including mixed user/tool-result blocks. Preserve code and bounded exact
  instructions through fresh-session rollover; seal the old session durably.
- Expose safe capabilities and bounded metadata for tools, logical provider calls,
  compaction and useful progress. Keep heartbeat separate from progress. Carry
  diagnostic UUIDs through the fixed relay to gateway audit without forwarding
  them to the model upstream.
- Persist small sequential workflows with exact request reconciliation, atomic
  source/acceptance gates, cancellation recovery, cleanup references and observed
  token/cost budgets that reject unavailable per-response measurements.

## Final checks

All builds, suites and services ran on gram. No local install, build, suite,
database or service was run on the Mac. Tests used Node `24.22.0-bookworm`, pinned
Pi `1.4.0`, task-owned directories and local mocks. No paid or corporate model
endpoint, live MCP configuration or global setting was changed or invoked.

The fresh production Dockerfile image for `661a898` is
`sha256:fc6381cf4d91bf09dc318194f97de6be1e1116bc011fcbe60adafd0b49422540`.

- Exact-source full suite: **322/322 passed**, 15 suites, 0 failed, cancelled,
  skipped or todo; 253080.470ms. The build and tests used the final `661a898`
  executable source, including both final context and relay corrections.
- Fresh Docker preflight and admission passed. Actual UID1000 agent had a
  read-only root, zero effective capabilities, no-new-privileges, seccomp/LSM,
  network none, and private volumes without host source/state/socket mounts.
- Actual Pi read/tool roundtrip, client reconnect, followup and cancellation
  passed. TCP/UDP/DNS and AF_VSOCK checks passed; proxy override, socket unlink/
  rename and MCP startup with the gateway stopped were denied. The controlled
  forbidden service received **0 requests**.
- The new harness profile passed capabilities and **18 MCP tools**, fresh review
  with matching code digest, explicit approval/rejection, idempotent replay that
  cannot revive an old approval, rollover and sealed-session resume refusal.
  All **6 logical provider calls** across source/review/rollover correlated with
  gateway ingress records by job, logical-request and provider-call UUIDs.
- Final independent Astra review found no remaining blocking issue. Parent
  `git diff --check` and scoped source/diff review passed.

### Reproduction commands

The task root was `/tmp/pi-harness-final-20261024` on gram. Archive the committed
source into its fresh `build` directory, then:

```sh
BUILDX_CONFIG=/tmp/pi-harness-final-20261024/buildx \
  docker build -f internal-agent/Dockerfile \
  -t pi-internal-agent:pi-harness-final-20261024 .
```

The full suite ran in a disposable container from that image, network none,
UID0, 2 CPUs, 2 GiB, PID limit512. Mount committed `test` at `/app/test` writable
(fixtures set executable bits), and `scripts`, `docs`, `examples` read-only at
their `/app` paths. Keep `/app/src`, `/app/internal-agent` and dependencies from
the built image. The disposable root user is needed for root-owned packaged
grader fixtures; the actual isolation profile separately runs UID1000.

```sh
mkdir -p /app/approved-mcp
cp /app/test/fixtures/approved-mcp-stdio.mjs /app/approved-mcp/mock.mjs
ln -s /app/approved-mcp /app/approved-mcp/link
chmod 0555 /app/approved-mcp /app/approved-mcp/mock.mjs
timeout 480s node --test --test-concurrency=1 test/*.test.mjs
```

The fresh profile used the existing `setup-internal-agent-test.py`, task-only
mock/forbidden containers and a temporary CA on a private Docker network, without
published ports. Source the generated task-only `compose.env` for each command.
Use `check-internal-agent.py --project pi-harness-final-20261024 --preflight-only`,
then Compose `up -d` and the same checker without `--preflight-only`. Import a
Git bundle of the exact integration commit using `internal-agent/import-bundle.mjs`.

```sh
python3 scripts/test-internal-agent.py \
  --project pi-harness-final-20261024 \
  --compose /tmp/pi-harness-final-20261024/build/internal-agent/compose.yaml \
  --forbidden-ip 172.24.0.3 \
  --forbidden-container pi-harness-final-20261024-forbidden \
  --repository /workspace/private-source \
  --base-ref 661a898e715ac16eb80224b880a3be8c7371cd93 \
  --missing-gateway-test
python3 /tmp/pi-harness-final-20261024/harness-profile-check.py \
  661a898e715ac16eb80224b880a3be8c7371cd93
```

The small parent-owned harness probe and exact full-suite shell invocation are
retained with logs in `/tmp/pi-harness-regression-evidence-20261024` on gram.
The probe uses the existing MCP test client and no real credentials.

## Earlier failures and correction evidence

The preflight on `86a405f` ran 306 tests: 300 passed, six failed. Five were the
same optional-material-description normalization regression, fixed in `6c193aa`
with the existing affected suites passing 14/14. The remaining process-race
fixture omitted the newly required raw-session checkpoint; correcting the fixture
preserved its one-child concurrency assertion.

The later `c52b85a` full suite passed **320/320**, 15 suites, no failed/cancelled/
skipped tests, 252134ms. Actual Docker acceptance then exposed missing relay trace
forwarding, while independent review found mixed provider user blocks could lose
instructions. Both new focused tests failed before their fixes and passed after.
Gateway/MCP regression passed 15/15 and actual Pi context checks passed 5/5 before
building the final image. The earlier failed profile log is retained separately;
its success before the trace assertion is not described as a full profile pass.

Detailed commands and actual RED/GREEN results:
[safety](harness-safety-report.md), [tools](harness-tools-report.md),
[runtime](harness-runtime-report.md), [runtime corrections](harness-runtime-fixes-report.md),
[workflow](harness-workflow-report.md), [observation/workflow corrections](harness-corrections-report.md),
[final context/relay corrections](harness-final-fixes-report.md).
Some later regression cases were added after implementation; their reports
explicitly distinguish them from pre-implementation RED runs.

## Pending evaluation and limits

The reproducible task-evaluation runner/task set remains **unimplemented**.
The explicitly selected Sonnet5 bridge job
`task-834e646b-d1c9-4531-949f-437df7ae20a8` verified its model identity but stopped
before any edit when its first Git identity command was denied by the bridge
allowlist. Its terminal process status is not task completion. The user decision
on a narrowly scoped read-only Git allowlist change remains pending. The supplied
AGENTS rule prohibits bypassing a denial; no replacement model, alternate command
route or live/global configuration edit was used. Bridge settings are cached for
the process, so an eventual approved change also needs an explicit controlled
bridge reload/new session. No model quality benchmark is claimed by these tests.

Image-dependent or legacy-unknown context refuses fresh rollover; images are not
silently omitted. The exact instruction ledger and fresh handoff are bounded as
documented in [runtime](harness-runtime.md). Generic Pi SDK physical retry counts
are unavailable. Gateway request IDs identify observed ingress, and bounded repeat
flags are diagnostic, not durable retry or billing evidence. Review attestations
have caller authority, not authenticated-human authority. Packaged-file integrity
does not provide per-user OS isolation. Workflow budgets check between stages and
may be exceeded by an in-flight child. Real corporate acceptance remains separate.

Task containers, network, private volumes, task image tags, source/config copies
and temporary certificate/key files were removed after evidence preservation.
Shared Docker build caches were not pruned. Clean local review worktrees remain.
Final local-main integration follows the separate handoff commit. No push,
publication, deployment or live MCP update is part of this integration.
