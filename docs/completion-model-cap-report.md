# Completion model and gateway cap correction

The approved model example now requests at most 4096 output tokens, matching the gateway example. The admission preflight requires `maxTokens` and the effective gateway `maxOutputTokens` to be positive integers (excluding booleans), caps gateway output at 16384, applies the 4096 default when omitted, and refuses a model cap above the gateway cap. The pair configuration note documents that relationship.

## Verification

- Red: `node --test test/completion-model-cap.test.mjs` in `pi-mcp-completion:base-20261024` on gram failed on the oversized model case (`true !== false`), demonstrating the existing preflight accepted an incompatible pair.
- Green: `node --test test/completion-model-cap.test.mjs` in the same image on gram — passed, 3 tests / 3 pass / 0 fail (0.71 seconds).
- The test invokes `scripts/check-internal-agent.py --preflight-only` with temporary canonical config files; no container services or upstream endpoints are used.

The focused run was executed with `docker run --rm --network none -v /tmp/pi-mcp-completion-20261024/model-cap:/work -w /work pi-mcp-completion:base-20261024 node --test test/completion-model-cap.test.mjs` via `ssh gram`.
