# Pi MCP

[사내 전용 격리 Pi 에이전트 설정](docs/internal-agent.md)은 별도 opt-in Docker 프로필입니다.

Pi MCP delegates bounded coding and review tasks to [Pi coding agent](https://github.com/earendil-works/pi) through seven MCP stdio tools. Each new task starts at a committed Git ref in its own branch and worktree. It returns a job ID immediately; the detached worker continues if the MCP client disconnects. Followups reuse the same worktree and Pi session.

## Install and configure

Use Node.js 22.19 or newer. Run `npm ci` in this repository. The lockfile pins Pi 1.4.0; the service rejects a different Pi version. Install `rg` and `fd` on the worker host for Pi's grep/find tools. `pi_health` reports whether they are on the child PATH without making a provider request.

Create a private JSON configuration from [examples/config.example.json](examples/config.example.json). Set absolute `piPath`, `stateDir`, and `allowedRoots`; set `piArgs` if `piPath` launches Node rather than the Pi executable. Configure both `provider` and `model`, or supply a pair in `pi_delegate`. A model-only override uses the configured provider; a provider override requires a model. Keep the config and state directory owner-private. Point your MCP client at `node /absolute/path/to/pi-mcp/src/server.mjs` with `PI_MCP_CONFIG=/absolute/path/to/config.json`; [examples/mcp.example.json](examples/mcp.example.json) shows the client shape. [Corporate setup](docs/corporate-setup.md) covers proxies, CA certificates, private registries, local cloned repositories, and custom LLM gateway `headers` (see [examples/models.example.json](examples/models.example.json)); missing or invalid header configuration is rejected before any provider request.

`pi_health` checks executable version, configured paths, credential presence, concurrency and tool prerequisites. Credential presence does not prove provider authentication. The service does not make a paid model call for health.

## Task lifecycle

Call `pi_delegate` with an absolute repository root, title, prompt, and optional committed `base_ref`. The selected commit is checked out in `stateDir/worktrees/task-…` on a `codex/pi/…` branch. Dirty source changes, ignored files, and `.env` are not copied; the response warns when the source is dirty. Send context in the prompt and review the preserved worktree before integration. `request_id` makes an exact retry idempotent and rejects a conflicting retry.

Use `pi_status` (optional wait up to 45 seconds), `pi_result`, and `pi_list` to observe progress. The worker marks success only after Pi emits `agent_settled`, a final assistant response, and a clean stop reason. Failed, cancelled, timed-out and interrupted worktrees remain intact. `pi_cancel` requests queue clearing and abort, then terminates the Pi process group. If a worker dies and the process group cannot be identified safely, the job is quarantined and continues to count against concurrency until an operator verifies cleanup. `pi_followup` starts a new job record using the parent worktree and exact saved session. If no session path was ever recorded, it starts a fresh session in that worktree's private session directory. A recorded but missing session fails closed; the parent result remains available.

Results contain bounded sanitized text, progress, usage, permission denials, tracked diff and an untracked-file inventory. Full raw Pi session history stays in the private `stateDir/sessions` tree and may contain prompts or provider data. Do not share it as a public artifact. The service never commits, merges, pushes, clones, or publishes on behalf of a task.

## Permissions and trust

Pi starts with ambient extensions, MCP servers, skills, prompt templates, themes, project context files and project approval disabled. It explicitly loads a policy extension and waits for its readiness acknowledgement before any prompt. Review mode exposes read, grep, find and ls. Implement mode also exposes write, edit and `safe_shell`. Paths are checked against the canonical worktree and Git administration paths are protected. Built-in bash is disabled. `safe_shell` accepts only an administrator-configured **exact full command**, such as `npm test`; it does not do prefix matching. An approved command can run repository scripts with the worker's OS permissions. This policy controls Pi tools; it is not an OS sandbox. Use trusted repositories and commands.

The runtime seeds only explicit `models.json` and `auth.json` into its private shared agent directory. Shared auth lets Pi coordinate OAuth refresh across workers. Existing refreshed auth is never overwritten by the original seed. A copied login from another Pi agent directory may still be invalidated remotely by a competing refresh; a dedicated pi-mcp login is safest. Command-based credential values in models/auth are rejected. Changing the model file requires stopping jobs and an explicit agent configuration reset. Pi runs offline for startup/catalog traffic but still sends model requests to the selected provider. `HTTP_PROXY` and `HTTPS_PROXY` control Pi's HTTP dispatch; `ALL_PROXY` is forwarded for Git/tooling but alone is not a Pi HTTP proxy setting.

Run `npm test` on an appropriate remote build host. The suite includes fake Pi process lifecycle tests, actual MCP stdio, and released Pi 1.4.0 against a local mock model gateway. No paid provider keys are needed for those tests.
