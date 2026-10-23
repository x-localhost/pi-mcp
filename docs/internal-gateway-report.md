# Internal agent gateway unit report — 2026-10-23

## Scope and interface

Worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/internal-agent-gateway`, branch `codex/internal-agent/gateway`, committed base `295c4af7ce8e525ecd32a5178fedfc788c05c734` were verified before writing. Only these files changed:

- `internal-agent/gateway.mjs`: fixed Unix-socket HTTP endpoint, strict administrator config, pinned private IPv4 HTTPS transport with TLS hostname verification, gateway-environment header resolution, request schema and size validation, generic upstream failures and bounded lifecycle.
- `internal-agent/relay.mjs`: loopback-only forwarding to one fixed Unix socket, no target selection, clean shutdown.
- `test/internal-gateway.test.mjs`: focused node:test tests with an injected TLS transport. No external endpoint was called.
- `docs/internal-gateway-report.md`: this report.

CLI: `node /app/internal-agent/gateway.mjs /etc/pi-internal/gateway.json /run/pi-internal/gateway.sock`. Gateway config has exactly `upstreamUrl`, `upstreamAddress`, `model`, optional `caFile`, and optional `headers`. The URL may include a fixed safe prefix, such as `/api/v1/chat/completions`; incoming requests still use `/v1/chat/completions` and cannot choose a path. `headers` uses `$NAME` or `${NAME}` references resolved from the gateway process environment only; credential-looking header names require a reference. `caFile` must be an absolute regular file. The gateway listener accepts only `GET /healthz` and `POST /v1/chat/completions`. `startRelay({ socketPath, port = 18080 })` returns `{ address: '127.0.0.1', port, close: async () => void }`. The socket is created mode `0600`; both containers must use the same numeric UID to connect through the read-only socket-volume mount.

The module accepts ordinary function tools, text URLs, and inline base64 image data. It rejects unknown fields and routes, server tools, remote media, non-private pinned addresses, invalid header templates, and mismatched model IDs. Successful upstream responses stream with backpressure and explicitly expose only `Content-Type`; non-2xx, redirects, transport failures and invalid success content types return generic errors. Fixed bounds: 4 MiB request body, 16 KiB request headers, eight active chat requests, 32 connections, 10-second connect/header timeout, 15-second body timeout, 30-second upstream idle timeout, 120-second upstream total timeout.

## RED / GREEN evidence on gram

Test source was copied with `scp test/internal-gateway.test.mjs gram:/tmp/pi-mcp-internal-20261023/gateway/test/`, `scp internal-agent/gateway.mjs internal-agent/relay.mjs gram:/tmp/pi-mcp-internal-20261023/gateway/internal-agent/`, and `scp src/headers.mjs gram:/tmp/pi-mcp-internal-20261023/gateway/src/` (after `ssh gram 'mkdir -p ...'`). All test execution used the already available `node:24.22.0-bookworm` image with `--network none` and a read-only source mount. The task directory was isolated from the runtime worker's directory.

- RED: `ssh gram 'docker run --rm --network none -v /tmp/pi-mcp-internal-20261023/gateway:/work:ro -w /work node:24.22.0-bookworm node --test test/internal-gateway.test.mjs'` exited 1: the new gateway module was absent (`ERR_MODULE_NOT_FOUND`), one test file failed. This is the expected missing-implementation failure.
- Initial GREEN: the same command exited 0 with six tests passed after implementation and fixture corrections.
- Final focused run: `ssh gram 'timeout 15s docker run --rm --network none -v /tmp/pi-mcp-internal-20261023/gateway:/work:ro -w /work node:24.22.0-bookworm node --test test/internal-gateway.test.mjs'` exited 0 with ten tests passed, zero failed, zero skipped. This includes the positive function-tool round-trip assertion and fixed administrator prefix path behavior.
- `git diff --check` exited 0. `git diff --no-index --check /dev/null <each new file>` emitted no whitespace diagnostics; each command exited 1 because the file differs from `/dev/null`. Files remain uncommitted for parent review.

## Integration and limits

The focused suite injects an HTTPS request function and checks pinned request options, policy and response behavior without contacting any public or corporate endpoint. It does not prove actual certificate validation, Docker network isolation, named-volume or UID permissions, or compatibility with the installed Pi client. Parent/runtime integration and independent regression must verify those boundaries with controlled private mock services. Real corporate hostname, address, CA and credentials remain unavailable; no deployment or paid model call occurred. The approved LLM service's own routing and search behavior is an administrator prerequisite outside this client-side gateway's control.

## Pi 1.4.0 integration fix — 2026-10-23

Parent committed the original gateway unit at `086d73c69d9e36e68f97ab98a850a55c1a214a2d`. Runtime then observed a real Pi 1.4.0 request rejected with `400` before the private fake upstream received it. A test-only shape capture showed root keys `max_completion_tokens,messages,model,store,stream,stream_options,tools`; `store` was boolean `false`. The gateway now accepts exactly `store: false` and rejects `true` or other values, preserving the explicit retention boundary. The tool and message shapes required no other compatibility change.

Independent review also identified that `$dynamicRef` and `$recursiveRef` in a function or response schema needed the same local-fragment rule as `$ref`. All three now require a `#/` reference and reject remote or relative document references. Gateway header-template references now reject process-control environment names. Runtime's host preflight applies the matching env-file name rule **before** starting Node; gateway validation is an additional check, not a substitute for that earlier control.

RED: after copying the new test file to gram, `ssh gram 'timeout 15s docker run --rm --network none -v /tmp/pi-mcp-internal-20261023/gateway:/work:ro -w /work node:24.22.0-bookworm node --test --test-name-pattern="Pi store|schema references" test/internal-gateway.test.mjs'` exited 1: two expected failures, one for missing `store` support and one for accepted remote `$dynamicRef`/`$recursiveRef`. The separate `--test-name-pattern="configuration pins"` run exited 1 on a newly added unsafe-env-reference assertion. GREEN: after copying `internal-agent/gateway.mjs` and the test file to the same remote unit directory, the full `node --test test/internal-gateway.test.mjs` command above exited 0 with **12 passed, 0 failed, 0 skipped**. No real corporate endpoint was contacted.
