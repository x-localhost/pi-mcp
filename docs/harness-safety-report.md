# Harness safety unit report

Base: `84301bf3a56b8e5f9f36247d907a6d3a6fd3d61c` on branch `codex/harness/safety`.

`confinedPath` now rejects `file:` URL spellings before lexical authorization, including write requests where missing-path creation would otherwise permit the lexical decoy. Both implement and review authorization use this shared check. A direct review-read regression creates both an external marker and the worktree-relative `file:/...` lexical decoy that the old code would admit. Released Pi 1.4.0 was exercised against a local mock provider; a `file:///...` write request was denied, completed with a permission denial, and did not create its external marker.

`scanState` still requires a canonical state root, uses `lstat`, and rejects special files. It now counts symlink metadata and stops at the link without resolving or opening the target, so a repository symlink within the managed state tree does not prevent admission or health checks. The test separately proves external target contents are not counted, then commits an internal symlink to `base.txt`, submits and dispatches a manager job to materialize that worktree, and confirms a second submission and health check succeed.

## Verification

- RED: `ssh gram 'docker run --rm --network none -v /tmp/pi-harness-implementation-20261024/safety/workspace/src:/app/src -v /tmp/pi-harness-implementation-20261024/safety/workspace/test:/app/test -w /app pi-harness-review:52a1335 node --test test/harness-safety.test.mjs'` — 2 tests, 0 passed, 2 failed as expected: file URI write path was admitted; symlink caused `Unsafe state entry`.
- GREEN: same command after the implementation and evidence updates — 3 tests passed, 0 failed (about 3.6 seconds). It includes the real Pi mock-provider denial test with terminal completion, direct implement/review URI checks with lexical decoy and external marker, and external-target accounting plus actual manager dispatch of a committed internal symlink followed by a second admission and health check.

Remote test source was copied to `/tmp/pi-harness-implementation-20261024/safety/workspace` on gram and mounted into the pinned `pi-harness-review:52a1335` container with network disabled. An initial invocation mounted at `/workspace` and could not resolve the image's installed dependencies; rerunning with source/test mounted over `/app/src` and `/app/test` used the image's pinned `/app/node_modules` successfully.

Changed files: `src/policy.mjs`, `src/storage.mjs`, `test/harness-safety.test.mjs`, `docs/harness-safety-report.md`.
