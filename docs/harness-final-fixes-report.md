# Final context and relay corrections — 2026-10-24

Worktree `/Users/leebw/workspace/claude/pi-mcp-worktrees/harness-final-fixes`, branch `codex/harness/final-fixes`, committed base `c52b85aeeffe74384c19dca5a557e56755e63ff0`. Root, branch, base, and clean initial status were verified before edits. Changes remain uncommitted for parent review.

Changed files:

- `src/context-policy.mjs`: a user content array is a disposable tool-result message only when it is nonempty and every block is a `tool_result`. A mixed tool result and text/image message stays mandatory as one user message.
- `internal-agent/relay.mjs`: chat requests alone may forward the existing `x-pi-job-id`, `x-pi-request-id`, `x-pi-attempt-id` trio to the fixed Unix gateway. Relay checks all-or-none presence, a single raw header occurrence per name, and strict UUID syntax before forwarding. It does not forward arbitrary, auth, or private client headers; MCP and health routes do not gain trace forwarding.
- `test/harness-tools.test.mjs`: oversized assistant tool-use with a mixed result/instruction or result/image must fail closed; an unrelated old assistant message can still be removed while the mixed instruction stays.
- `test/harness-final-relay.test.mjs`: real loopback relay→Unix gateway correlation, malformed/incomplete/duplicate rejection, private-header stripping, and non-chat route scope.

Only gram ran tests. The task directory was created with `ssh gram 'mkdir -p /tmp/pi-harness-implementation-20261024/final-fixes/app'`, then synced with:

```sh
tar --no-xattrs -cf - src test internal-agent scripts docs examples package.json package-lock.json | ssh gram 'tar -xf - -C /tmp/pi-harness-implementation-20261024/final-fixes/app'
```

Every remote test used image `pi-harness-implementation:test-20261024`, `--network none`, UID `1001:1001`, and separate task mounts. One exact invocation was:

```sh
ssh gram 'docker run --rm --network none --user 1001:1001 -v /tmp/pi-harness-implementation-20261024/final-fixes/app/src:/app/src -v /tmp/pi-harness-implementation-20261024/final-fixes/app/test:/app/test -v /tmp/pi-harness-implementation-20261024/final-fixes/app/internal-agent:/app/internal-agent -v /tmp/pi-harness-implementation-20261024/final-fixes/app/scripts:/app/scripts -v /tmp/pi-harness-implementation-20261024/final-fixes/app/docs:/app/docs -v /tmp/pi-harness-implementation-20261024/final-fixes/app/examples:/app/examples -v /tmp/pi-harness-implementation-20261024/final-fixes/app/package.json:/app/package.json -w /app pi-harness-implementation:test-20261024 node --test test/harness-final-relay.test.mjs'
```

The same Docker invocation used these exact `node --test` arguments and produced these observed results:

- `--test-name-pattern="mixed user tool result" test/harness-tools.test.mjs`: RED 0/1 (`reduceContext` returned `ok:true`, expected `false`); GREEN 1/1.
- `test/harness-final-relay.test.mjs`: RED 0/1 (gateway audit `jobId` absent); GREEN 1/1.
- `test/internal-gateway.test.mjs test/approved-mcp-bridge.test.mjs`: 15/15 passed, covering fixed gateway routes and the existing MCP relay.
- `test/harness-context.test.mjs`: 5/5 passed against pinned Pi and local mocks, including impossible mandatory context and 429/transport behavior.

No full suite, live profile, paid endpoint, or external service was run in this unit. Parent owns final broader verification and the commit.
