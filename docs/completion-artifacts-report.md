# Completion artifacts/offline unit report — 2026-10-24

Worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/completion-artifacts`, branch `codex/completion/artifacts`, base `5ce1c5dac06aa24118b1707bf8f14dd9cd9643d5`. Root, branch, HEAD, and clean starting status were verified before writing. No commit, push, live settings edit, or local suite/build was performed.

## Changed files

- `src/artifacts.mjs`: bounded private checkpoint, separate sanitized public manifest/blobs, reports, paging, integrity checks, restore.
- `src/offline-materials.mjs`: validated pinned material bundles, read-only packer, LFS and gitlink overlays, staged worktree application and material identity.
- `internal-agent/import-material.mjs`: stdin-only private import under the isolated profile.
- `internal-agent/export-artifacts.mjs`: terminal-job public export under the manager lock.
- `internal-agent/Dockerfile.project.example`: pinned Node base and offline project-image recipe.
- `scripts/pack-material.mjs`, `scripts/save-artifact-export.mjs`: host pack and new-file verified export save.
- `test/completion-artifacts.test.mjs`: twelve focused behavior and boundary tests.
- `docs/offline-artifacts.md`: operating format, limits and flow.
- `docs/completion-artifacts-report.md`: this report.

## Integration contract

`validateArtifactConfig(raw)` returns `{maxFiles,maxFileBytes,maxTotalBytes,maxReadBytes}`. `snapshotArtifacts({jobDir,worktree,baseCommit,config,sanitize,env,materialBaseline,inputMaterialsDigest,reports})` returns the public manifest with `{version,entries,omissions,omittedCount,omissionsTruncated,checkpointComplete,exportComplete,complete,truncated,applicable,sourceBaselineCommit,inputMaterialsDigest,inputSnapshotDigest,maxReadBytes,manifestSha256}`. Reports are explicit `{name,file}` pairs from the fixed allowlist `result/result.json`, `verification/verification.json`, `stdout/stdout.log`, `stderr/stderr.log`. Snapshot only after all writers and verifiers stop. `listArtifacts(jobDir,{cursor,limit,omissionCursor})` pages both entries and omissions with `nextCursor` and `nextOmissionCursor`. `readArtifact(jobDir,{artifact_id,offset,length})` returns `{artifact_id,offset,data_base64,encoding,sha256,totalSha256,nextOffset,eof,size}`; `sha256` is the page hash. `restoreCheckpoint({jobDir,worktree,env})` returns `{restored,inputSnapshotDigest,baseCommit}` and requires a fresh pinned base worktree with the same material baseline already reapplied.

`validateOfflineConfig(raw,configDir)` returns `{materials}` with normalized declarations. `applyOfflineMaterials({worktree,baseCommit,selections,config,env})` returns `{materials,inputMaterialsDigest,materialBaseline,fileCount}`. The manager should persist the latter two fields on the job, pass them to snapshot, reapply the same selected IDs to a fresh fork worktree before restore, and include `inputMaterialsDigest` in job input identity. The material baseline covers imported files even under Git-ignored paths; only deviations from that baseline become artifact changes. A `submodule` declaration requires `submoduleCommit` equal to the parent commit's gitlink SHA. The internal export helper expects runtime terminal status and its shared `Manager.lock`; parent runtime integration should adapt terminal status names if new ones are introduced.

Private checkpoint and public export completeness are independent. Redacted or omitted public content is explicitly not applicable as a faithful code export. Exact safe binary bytes can be paged and exported; binary with a detected known secret is omitted. Raw checkpoint bytes are never available through public readers/export. A rename is represented as delete plus file, preserving final worktree content and mode. All exported hashes describe exported bytes.

## Commands and observed results

RED: after writing the first test, copied it to `gram:/tmp/pi-mcp-completion-20261024/artifacts/test` and ran `docker run --rm --network none --user 0:0 -v /tmp/pi-mcp-completion-20261024/artifacts/test:/app/test:ro -w /app pi-mcp-completion:base-20261024 node --test test/completion-artifacts.test.mjs` over `ssh gram`. It failed with `ERR_MODULE_NOT_FOUND` for `/app/src/artifacts.mjs`, the absent behavior entry point. The initial transfer required creating/chowning only this unit's remote temporary directories; those setup failures were corrected before the RED result.

GREEN: `rsync -a` copied the scoped source/test/scripts into the unit's remote temporary directories. The final command was `ssh gram 'docker run --rm --network none --user 0:0 -v /tmp/pi-mcp-completion-20261024/artifacts/src:/app/src:ro -v /tmp/pi-mcp-completion-20261024/artifacts/test:/app/test:ro -v /tmp/pi-mcp-completion-20261024/artifacts/scripts:/app/scripts:ro -w /app pi-mcp-completion:base-20261024 node --test test/completion-artifacts.test.mjs'`. Result: 12 tests, 12 pass, 0 fail, 0 skipped, 2.17 seconds. Earlier targeted green runs passed at 3, 7, 9, and 11 tests while hardening was added.

The tests cover private bytes/modes/deletions/renames and followup immutability; public redaction and exact 1.2 MiB binary reconstruction across pages; ASCII and Unicode secret-bearing binary omission; sanitized reports; same-path mutation and file/public-output limits; public/private blob symlink tampering; new-file export save with hash verification; a runnable offline `require` dependency; malicious bundle path/collision and two-material no-partial-apply; LFS expected-original hash and restoration; gitlink-pinned submodule flattening; and changed/deleted Git-ignored imported files.

`ssh gram 'docker run --rm --network none --user 0:0 -v /tmp/pi-mcp-completion-20261024/artifacts/internal-agent:/app/internal-agent:ro -v /tmp/pi-mcp-completion-20261024/artifacts/scripts:/app/scripts:ro -w /app pi-mcp-completion:base-20261024 sh -c "node --check internal-agent/import-material.mjs && node --check internal-agent/export-artifacts.mjs && node --check scripts/pack-material.mjs && node --check scripts/save-artifact-export.mjs"'` passed (exit 0). Local `git diff --check` passed. No paid endpoint or runtime service was called.

## Remaining integration limits

The import/export CLIs were syntax checked under the base image, not executed under the final gateway/profile image; the runtime and gateway owners must integrate and exercise them under the real isolated profile. The example project Dockerfile requires administrator-supplied offline npm cache and project tools, so it was not built in this unit. Public sanitation finds configured known secrets and common token forms, not arbitrary unknown secrets. The limits are application bounds; external filesystem writers with the same state-volume access are outside the checkpoint integrity model.
