# Corporate LLM custom headers — 2026-10-23

## Base and scope

Clean committed main: `18f804844484a4e06a59527d8bbd17c12dc1fc21`. Integration: `codex/corporate-headers/integration`, `/Users/leebw/workspace/claude/pi-mcp-worktrees/corporate-headers`. Existing worktrees and changes are preserved. User requests corporate LLM API support with multiple custom headers. API dialect/header names are pending optional clarification; implement and demonstrate OpenAI-compatible Chat Completions using fake credentials, retaining existing Pi provider configurations. No paid model calls, company endpoint calls, deployment, global/live MCP changes, or push.

## Contract

- Reuse Pi 1.4.0 `models.json` provider/model `headers` and `envAllowlist`; avoid a redundant config dialect or a new proxy server. Header names are configurable, including custom authentication and client metadata headers. API protocol is separate from authentication headers.
- Validate header configuration before creating a job or sending a request: valid HTTP names/string values, no CR/LF or invalid bytes, no executable credential commands, and no missing/empty referenced environment variables in the forwarded child environment. Honor Pi's exact `$NAME`, `${NAME}`, embedded and escaped-value semantics. Validate seeded configuration again on later submissions so environment changes cannot bypass checks. Errors must not echo secret values.
- Preserve reference strings in private models storage rather than materializing credentials; do not add header values to MCP inputs, health output or job metadata. Existing state/model-refresh lifecycle remains explicit.
- Verify actual Pi requests to a loopback mock gateway carry multiple custom headers and existing authorization across a tool round trip; check model-specific headers and supported custom Authorization behavior. Do not claim `authHeader:false` removes SDK-generated Authorization without proving it. Keep current OAuth and regular provider behavior.
- Cover secret redaction in public status/result/log/error/patch paths for arbitrary header names and interpolated values. Private Pi sessions remain sensitive; custom headers do not establish an OS sandbox or corporate-only egress boundary. Earlier Git-hook/textconv/egress findings are outside this feature.
- Document exact config/env setup, compatible API requirements (streaming/tool calls), secret rotation/restart, and real corporate acceptance still pending.

## Units and resources

At planning: native `/root/core`, `/root/design_review`, `/root/regression` completed, no active native jobs. Refreshed Claude health: logged in, permitted root `/Users/leebw/workspace/claude`, activeJobs=0; gram reachable, low load, required Docker image available. No recursive delegation; combined active delegates <=3.

1. Independent native `astra_reviewer` reviews this bounded authentication/validation design; no edits. Lead addresses findings.
2. Sonnet 5 bridge owns implementation, focused unit/integration tests, example config/model and corporate documentation in its bridge-managed isolated worktree/branch from this committed plan. Scope: header validation helper, manager/worker/sanitizer integration only as required, header tests, examples, guide, unit report. Parent supplies role constraints and verifies actual model identity. RED tests are delivered first; parent runs remote tests if bridge cannot access gram within its approved commands, then resumes GREEN. A denial is not bypassed.
3. Parent reviews and commits implementation, integrates serially; independent tester from a committed handoff verifies affected behavior if boundary changes warrant. Lead final review, scoped work commit and separate bounded handoff commit, then fast-forward clean main.

All install/tests on gram in `/tmp/pi-mcp-headers-20261023/`, separate build/check directories or sequential mounts, disposable `node:24.22.0-bookworm` containers without published ports. Install locked dependencies once; test runtime with `--network none` and only loopback fake APIs. Mac only Git/editing/quick static checks. No changes to shared host/cluster configuration. Parent writes coordination artifacts only.

Assignment record: native `/root/design_review` resumed read-only at plan `3e1abc1`. Claude RED job `task-49ba8a85-6389-4b4b-848a-e3e612f83c59` owns `/Users/leebw/.codex/mcp/claude-delegate/state/worktrees/task-49ba8a85-6389-4b4b-848a-e3e612f83c59`, branch `codex/claude/49ba8a85-6389-4b4b-848a-e3e612f83c59`, same committed base. Combined active delegates: 2. Parent installed 207 locked packages remotely with `npm ci --ignore-scripts --no-audit --no-fund` for forthcoming tests.

Independent design amendments: validate syntax for all header maps but resolve required variables only for the selected provider/model, including modelOverrides; unrelated unused provider credentials must not block a job. Validate provider headers before model overlays, matching Pi. Share one non-executing escape-aware parser between preflight and redaction; mask explicitly known header values even below six characters. Repeat validation using owned configuration and actual worker environment before Pi starts. Preserve auth.env precedence: conventional saved API-key env overlays forwarded environment for provider and model headers; OAuth saved env overlays provider headers only, while model headers use forwarded environment. Do not invoke credential commands or refresh OAuth during static validation; exotic built-in auth resolvers are outside the tested custom gateway scope. This supersedes the child-environment-only wording above. Do not claim authHeader:false suppresses SDK Authorization.

Baseline validation on committed input: actual Pi gateway and HTTPS CONNECT/custom-CA tests **2/2 passed**, `docker run --rm --network none ... pi-mcp-headers-tools:20261023 node --test test/real-pi.test.mjs test/proxy-pi.test.mjs`. gram home volume was full for Docker build metadata; task-only BUILDX_CONFIG under the available `/tmp` filesystem allowed building the isolated rg/fd image without changing shared configuration or deleting other work. Secondary-host Docker was unavailable to its SSH user; no permission change or workaround attempted there. All tests stay on gram.

## Completion criteria

Actual Pi mock gateway proves configured custom headers across requests. Missing or invalid header configuration fails before model traffic, without leaking values. Existing model/auth/proxy regression checks remain green. Exact RED/GREEN commands/results and unresolved assumptions recorded, all scoped changes committed and handoff updated. Actual corporate endpoint authentication is unverified until endpoint contract and deployment secrets are supplied outside this conversation.
