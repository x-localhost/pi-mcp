# Configuration unit report

## Current evidence

- Runtime/config implementation snapshot integrated with dependency: `bc12451`.
- RED on gram (`node:24.22.0-bookworm`), command
  `node --test test/config.test.mjs`: initial **91 tests, 3 pass, 88 fail**;
  after test amendment **92 tests, 3 pass, 89 fail**. Failures were missing
  implementation behavior.
- GREEN on gram with the same command: **92/92 pass**.
- This report records parent-provided execution results; this documentation
  update did not rerun the suite.

## User-facing files

- `examples/config.example.json`: Node executable plus Pi CLI bundle argument,
  exact allowed command strings, and optional models file. No `agentDir`.
- `examples/models.example.json`: Pi 1.4.0 provider/model schema using
  `openai-completions` and environment-variable API key reference.
- `examples/mcp.example.json`: stdio server registration and proxy variables;
  no API-key placeholder value.
- `docs/corporate-setup.md`: Korean installation and setup guide covering
  Node/npm corporate network setup, config paths, secret injection, proxy and
  gateway separation, Git credentials, OAuth caveat, and operational limits.

## This documentation update

Changed only the four user-facing files above and this report. No runtime,
tests, package files, live settings, or user credentials were changed. A JSON
parse check was run for all three example files; no suite or network check was
run for this documentation change. No commits were made.
