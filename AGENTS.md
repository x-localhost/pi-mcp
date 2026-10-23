# Pi MCP project workflow

Use the user's global workflow. Lead owns architecture/review/integration; implementations delegated, no recursive delegation. Preserve unrelated changes, never mutate live MCP or global settings. Plan and interfaces are in `docs/plan.md`.

Run new feature TDD using node:test, RED before GREEN. Use task-isolated directories/containers on gram (`ssh gram`, Docker image `node:24.22.0-bookworm`); no local install/build/suite/services. Do not push, publish, deploy or call paid model endpoints. Each writer owns its assigned worktree/files. Report exact files, commands, observed results and unresolved issues, and leave commits to parent.
