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

## Completion criteria

Actual Pi mock gateway proves configured custom headers across requests. Missing or invalid header configuration fails before model traffic, without leaking values. Existing model/auth/proxy regression checks remain green. Exact RED/GREEN commands/results and unresolved assumptions recorded, all scoped changes committed and handoff updated. Actual corporate endpoint authentication is unverified until endpoint contract and deployment secrets are supplied outside this conversation.
