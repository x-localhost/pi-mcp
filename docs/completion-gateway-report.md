# Completion gateway unit report — 2026-10-24

Worktree: `/Users/leebw/workspace/claude/pi-mcp-worktrees/completion-gateway`; branch `codex/completion/gateway`; base `5ce1c5dac06aa24118b1707bf8f14dd9cd9643d5`. Parent owns commits and integration. All executable checks used task-isolated files under `/tmp/pi-mcp-completion-20261024/gateway` on gram and `pi-mcp-completion:base-20261024` with Docker `--network none`; no paid or company endpoint was contacted.

## Files changed

- `src/approved-mcp.mjs` (new): strict normalized administrator declarations, pinned tool schemas, local argument validation, packaged stdio MCP bridge, fixed internal HTTP bridge, session-scoped cleanup.
- `src/policy.mjs`, `src/policy-extension.mjs`: exact generated-name authorization, explicit review list, session-start registration and readiness, session-shutdown cleanup.
- `internal-agent/gateway.mjs`, `internal-agent/relay.mjs`: pinned internal MCP route, bounded stateless JSON-RPC subset, schema and response validation, output/rate limits, generic diagnostic categories and request IDs, bounded audit record.
- `internal-agent/profile.mjs`, `internal-agent/config.example.json`, `internal-agent/gateway.example.json`: explicit MCP and completion fields, text/image model capability, disabled-by-default examples.
- `scripts/check-internal-agent.py`: host preflight alignment of HTTP MCP declarations and gateway routes, fixed CA and secret header references.
- `test/approved-mcp.test.mjs`, `test/approved-mcp-bridge.test.mjs`, `test/completion-gateway.test.mjs`, `test/completion-profile.test.mjs`, `test/real-approved-mcp.test.mjs`, `test/fixtures/approved-mcp-stdio.mjs` (new); `test/internal-gateway.test.mjs` (updated for pinned output limit).
- This report.

## Contracts for integration

`validateApprovedMcp(raw)` returns `{ servers: [] }` when absent and rejects unknown fields. `approvedMcpToolNames(config, mode)` returns exact `mcp__<server>__<tool>` names for implement/review; review names come only from `reviewTools`. `registerApprovedMcp(pi, policy)` is async and returns `{ toolNames, close }`. Invoke it during Pi `session_start` and close on `session_shutdown`. The extension does this already.

**Pi CLI requirement discovered by the real run:** Pi 1.4.0 filters registered tools against `--tools`. Core worker must append `approvedMcpToolNames(runtime.approvedMcp, job.mode)` to the `--tools` argument **before Pi starts**, and expect those names in readiness. With only `read,grep,find,ls`, `getAllTools()` contained the MCP tool but `getActiveTools()` omitted it; the extension rejected readiness. With `mcp__docs__read` in `--tools`, the actual Pi run discovered, registered, declared, and executed it.

`approvedMcp.servers` entries are `{ id, transport, tools:[{name,description,inputSchema}], reviewTools }`. Stdio adds immutable packaged `command,args,cwd,env`. Internal HTTP adds `backendAttested:true` and derived route `/internal-mcp/<id>`. Gateway `mcpServers` entries pin `{id,upstreamUrl,upstreamAddress,caFile,headers,backendAttested:true,tools}` with the same tool declarations. Gateway `limits` is `{maxOutputTokens,maxN,requestsPerMinute}`, default 4096/1/60; it is gateway-only, not a profile key. Chat and approved MCP requests consume the same per-minute bucket. Model `input` is absent or exactly `['text']` or `['text','image']`.

The internal HTTP bridge supports only stateless JSON Streamable HTTP for `initialize`, `notifications/initialized`, `ping`, `tools/list`, and declared `tools/call`. It rejects batches, SSE, session IDs, callbacks, other notifications, remote URLs, redirects, and unknown routes. This is deliberately not a full MCP transport. `backendAttested:true` is an administrator policy assertion; the local code cannot prove the private backend has no independent egress.

Stdio permits only root-owned, non-group/world-writable executables and scripts beneath `/app/approved-mcp`, with root-owned immutable ancestor paths; Node may be `/usr/local/bin/node` with one packaged script argument. The child receives minimal explicit environment plus `MCP_` variables, not Pi/model credentials. Tool schemas are a bounded, reference-free JSON Schema subset, maximum 16 KiB each, arguments 16 KiB, results 32 KiB, HTTP frames 64 KiB, 4 servers, 16 tools/server, 2 active calls/server, 10-second MCP call deadline. Gateway chat body remains 4 MiB, upstream total deadline 120 seconds, concurrent requests 16. Gateway diagnostics contain only generated request ID, category, HTTP status, elapsed milliseconds, and completed/aborted flags, at most 256 records. A partial 200 stream is recorded with its failure category and `aborted:true`; the status records what the client saw, not success. No prompt, response body, upstream header, credential or environment value is recorded.

Profile currently checks the new `queue`, `verification`, `budgets`, `retention`, `artifacts`, and `offlineMaterials` entries are objects; final nested validation belongs to core's configuration normalizers at integration. Do not treat the profile object check alone as final validation.

## RED and GREEN evidence

Tests were synchronized with `scp` to gram, then run in task-isolated Docker containers. Focused RED runs before implementation:

- `node --test test/approved-mcp.test.mjs`: `ERR_MODULE_NOT_FOUND` before `src/approved-mcp.mjs` existed; later 2 assertion failures for generated-name collision and ambiguous authorization; symlink/dot packaged-path test failed before ancestor validation.
- `node --test test/completion-gateway.test.mjs`: missing `enforceChatLimits` export initially; later 1 assertion failure (`202 !== 502`) for a nonempty notification acknowledgement.
- `node --test test/completion-profile.test.mjs`: 2 failures for `input` and `approvedMcp` before profile changes.
- `node --test test/approved-mcp-bridge.test.mjs`: missing `httpRpc` export before total deadline, session, and truncated-response handling.
- `node --test test/real-approved-mcp.test.mjs`: actual Pi emitted `extension_error` because the MCP tool was not included in CLI `--tools`; the corrected allowlist passed. That RED caught the core integration requirement above.
- Follow-up `node --test test/completion-gateway.test.mjs` on gram: two focused RED assertions, MCP rate bypass (`502 !== 429`) and partial-stream audit (`ok !== upstream`). Both pass after the shared bucket and stream failure audit changes.

Final verification command on gram (after synchronizing owned files):

```sh
python3 -m py_compile /tmp/pi-mcp-completion-20261024/gateway/scripts/check-internal-agent.py
timeout 60s docker run --rm --network none --user 0:0 \
  -v /tmp/pi-mcp-completion-20261024/gateway/src:/app/src:ro \
  -v /tmp/pi-mcp-completion-20261024/gateway/test:/app/test:ro \
  -v /tmp/pi-mcp-completion-20261024/gateway/internal-agent:/app/internal-agent:ro \
  -w /app pi-mcp-completion:base-20261024 sh -c \
  'mkdir -p /app/approved-mcp && cp /app/test/fixtures/approved-mcp-stdio.mjs /app/approved-mcp/mock.mjs && ln -s /app/approved-mcp /app/approved-mcp/link && chmod 0555 /app/approved-mcp /app/approved-mcp/mock.mjs && runuser -u node -- node --test --test-concurrency=1 test/approved-mcp.test.mjs test/approved-mcp-bridge.test.mjs test/completion-gateway.test.mjs test/completion-profile.test.mjs test/internal-gateway.test.mjs test/real-approved-mcp.test.mjs'
```

Observed before follow-up: Python compile passed; node:test **30 tests, 30 pass, 0 fail**. The real Pi fixture took 1.2 seconds and confirmed the mock model saw the approved tool declaration and the MCP result. Follow-up affected gateway suites: **20 tests, 20 pass, 0 fail**. Full listed suite rerun after the follow-up: **32 tests, 32 pass, 0 fail**. No local build, install, suite, service or test ran.
