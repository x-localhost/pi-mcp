---
name: pi-delegation
description: Delegate bounded coding or review work to Pi through pi-mcp, then inspect and integrate its patch safely.
---

Use Pi for a bounded coding or review task with a clear acceptance test and an available committed base. Do not delegate tasks requiring uncommitted context, credentials, direct production access, or authority to merge or publish.

Brief Pi with the absolute server-visible repository path, resolved committed base SHA, narrow scope, explicit acceptance criteria, and exact verification IDs/commands. Use one job for sequential work. Use the `pi-worker` subagent when the main conversation should retain orchestration or when the worker loop needs an isolated context.

For independent tasks, start separate jobs and wait with `pi_wait` using `until: "any"`; remove settled IDs before the next call. Use `until: "all"` when all results are needed together.

Integrate in a clean worktree at the reported `baseCommit`. Save and inspect the complete patch, check `applicable`, omissions, hashes, and review findings, then run `git apply --check <patch>` followed by `git apply <patch>`. Use `git apply --3way` only as an explicit choice for a diverged target; it touches the index and may leave conflicts. Run local verification and review the resulting diff.

Save and verify the patch before considering cleanup. `pi_cleanup` is a human decision; never clean up automatically as part of delegation.
