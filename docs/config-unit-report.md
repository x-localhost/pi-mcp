# Corporate configuration unit — status report (GREEN implementation)

Scope: `src/config.mjs`, `test/config.test.mjs`, `examples/*.json`,
`docs/corporate-setup.md`, per `docs/plan.md` unit 3.

## Preflight (this job)

- `pwd`/`git rev-parse --show-toplevel`: both equal this worktree.
- `git branch --show-current`: `codex/claude/40513590-3a80-4229-90de-dc8644d54b73`.
- `git log --oneline -4` at start: `1f88feb` (test amendment) →
  `0cd503b` (RED commit) → `340acce` (plan base) → `2de0a49`.
- `git status`: clean before edits.

## RED outcome (reported by parent; executed on gram, not locally)

- `node --test test/config.test.mjs` in `node:24.22.0-bookworm`:
  **91 tests, 3 pass, 88 fail**, all failures explicit
  `Error('<name> not implemented')` — no import/setup failures.
- After the `1f88feb` test amendment (explicit-model-with-provider,
  secret-free `npmRegistry`): **92 tests** (parent-reported; not re-verified
  locally).

## Files changed this job

- `src/config.mjs` — full implementation of `validateConfig`,
  `buildChildEnv`, `redact`, `healthConfig`, `loadConfig` against the
  committed test contract (see inline comments for the path-resolution
  split, reserved-env-name list, and proxy/CA/registry mapping rules).
- `examples/config.example.json`, `examples/models.example.json`,
  `examples/mcp.example.json` — new corporate-proxy example config, a Pi
  `models.json`-format example (`provider: corporate`, `model:
  corporate-model`, `apiKey: "$CORP_LLM_API_KEY"`), and an MCP host
  registration snippet. No `!command` credential syntax used anywhere.
- `docs/corporate-setup.md` — new Korean-language operational guide:
  config field reference, proxy/CA/registry/env-allowlist rules, the
  OAuth-token-reuse caveat (concurrent use by pi-mcp and an ordinary Pi
  session can invalidate each other's refreshed tokens remotely; API-key
  env credentials are recommended instead), proxy-transport vs. LLM
  `baseUrl` distinction, and a note that core/runtime internals (shared
  state dir, once-seeded auth, session isolation) are out of this unit's
  scope. No claim of verified real corporate connectivity.
- `docs/config-unit-report.md` — this report, trimmed.

Not touched: anything under core's ownership, `package.json`/lockfiles,
`AGENTS.md`, `docs/plan.md`.

## New requirements implemented beyond the original RED stub

- `provider` requires `model` to also be set.
- `network.npmRegistry` rejects embedded userinfo credentials (secret-free
  registry config); `healthConfig` still defensively redacts it in case a
  caller constructs a config object directly without going through
  `validateConfig`.
- `envAllowlist` now also rejects `PI_*`, `GIT_CONFIG_*`, `ENV`, `BASH_ENV`
  in addition to the previously-blocked `NODE_*`/`LD_*`/`DYLD_*`/standard
  proxy/CA/npm-control names.
- Conservative `PATH` fallback (`/usr/bin:/bin`) when absent from source.
- `redact`'s known-secret-value scan now also extracts userinfo
  (username/password) from any URL-shaped `sourceEnv` value, not just
  credential-named keys.

## Commands run

- `pwd`, `git status`, `git rev-parse --show-toplevel`, `git rev-parse HEAD`,
  `git branch --show-current`, `git log --oneline`, `git show <sha> --stat`,
  `git show 1f88feb` — all for verification/inspection, no writes.
- No local `node` invocation was attempted (static-check and test execution
  are both denied by the sandbox for this job, per instructions); no
  workaround attempted. Implementation was verified by careful manual
  re-read of the full test file against the new `src/config.mjs`.

## Pending

**GREEN has not been run.** Parent will execute, expected:

```
node --test test/config.test.mjs
```

on gram (`node:24.22.0-bookworm`), expected to report 92/92 passing. This
report does not claim GREEN until that run is confirmed by the parent.

No commits were made in this job.
