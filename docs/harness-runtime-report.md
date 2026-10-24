# Runtime unit report — 2026-10-24

Base: `1a9cf52e3951dc4ea44af029dcaf9783e1244419` after the parent fast-forwarded the reviewed tools dependency into `codex/harness/runtime`. No commit, push, merge, deployment, paid model call, live MCP change, or global setting change was made by this unit.

## Files changed

- `src/manager.mjs`, `src/worker.mjs`, `src/server.mjs`, `src/config.mjs`, `src/verification.mjs`, `src/offline-materials.mjs`
- `src/acceptance.mjs`, `src/session-transition.mjs`, `src/capabilities.mjs`
- `test/mcp.test.mjs`, `test/harness-runtime-acceptance.test.mjs`, `test/harness-runtime-session.test.mjs`, `test/harness-runtime-capabilities.test.mjs`, `test/harness-runtime-manager.test.mjs`, `test/harness-runtime-verification.test.mjs`, `test/harness-runtime-worker.test.mjs`, `test/fixtures/harness-runtime-fake-pi.mjs`
- `docs/harness-runtime.md`, `docs/harness-runtime-report.md`

## Executed commands and observed results

The unit source, tests, scripts, documentation, examples, and package metadata were transferred to gram under `/tmp/pi-harness-implementation-20261024/runtime/app` using:

```sh
tar --no-xattrs -cf - src test internal-agent scripts docs examples package.json package-lock.json | ssh gram 'tar -xf - -C /tmp/pi-harness-implementation-20261024/runtime/app'
```

All Node tests used the pinned `pi-harness-implementation:test-20261024` image, `--network none`, and separate `/app/src`, `/app/test`, `/app/internal-agent`, `/app/scripts`, `/app/docs`, `/app/examples`, and `/app/package.json` bind mounts from that task directory. These mounts preserve image-packaged `/app/node_modules`; mounting the whole `/app` initially hid those dependencies and produced `ERR_MODULE_NOT_FOUND`, so that setup run was discarded. The source fixture mount belongs to UID 1001 on gram. A first MCP run as image UID 1000 failed `chmod` with `EPERM`; rerunning as UID 1001 passed.

Exact focused test arguments to `node --test` in the remote image and results:

- `test/harness-runtime-acceptance.test.mjs test/harness-runtime-session.test.mjs test/harness-runtime-capabilities.test.mjs test/harness-runtime-manager.test.mjs test/harness-runtime-worker.test.mjs` — 11/11 passed, including a 17 MiB raw session, independent review, automatic code-only rollover, idle stop, and repeated failure stop.
- After the final handoff and public rollover provenance edits, `test/harness-runtime-session.test.mjs test/harness-runtime-manager.test.mjs test/harness-runtime-worker.test.mjs` — 7/7 passed.
- `test/harness-runtime-verification.test.mjs` — 1/1 passed under container UID 0 to create root-owned test script and asset under `/opt/project-tools`; correct hashes passed, changed content and symlink failed preflight.
- `test/completion-runtime.test.mjs` — 28/28 passed after runtime changes.
- `test/mcp.test.mjs` — 2/2 passed with container UID 1001 after the mount-owner correction.
- `test/config.test.mjs test/manager.test.mjs test/mcp.test.mjs test/completion-runtime.test.mjs` — 126/128 passed on the first correct-mount run; only the two UID-related MCP `chmod` failures remained, and they passed on rerun.

The initial RED runs for the new acceptance, session, and capability helper tests failed with `ERR_MODULE_NOT_FOUND` for their then-absent feature modules. Each passed after the helper was implemented. The integrated worker test was added after its implementation and therefore does not claim a separate pre-implementation RED; its first run exposed a test polling mistake (queued jobs returned immediately), which was corrected before the 11/11 pass. Local checks were limited to `node --check` on changed JavaScript modules and `git diff --check`; both passed.

## Boundaries and pending integration

Acceptance uses immutable private source checkpoint entries and exact regular base-tree files, including unchanged files. The stable code digest is `artifacts.inputSnapshotDigest`; the artifact manifest digest can change when a report is attached. Review attestation is explicitly caller authority, not authenticated human or trusted grader authority. The protected-file contract validates declared root-owned packaged files but does not create per-user OS isolation.

The parent will run the final whole-suite check and isolated internal-profile gateway correlation on a committed integration SHA. Workflow cleanup-reference wiring belongs to the later workflow unit; runtime manager leaves that seam untouched.
