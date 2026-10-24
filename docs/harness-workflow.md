# Sequential workflow operator guide

The workflow CLI coordinates at most 16 sequential Pi jobs. It does not deploy, publish, commit, merge, or approve review findings. It uses the configured `PI_MCP_CONFIG` and existing Manager; it does not accept a shell command or arbitrary provider endpoint.

Create a private JSON plan with `version:1` and a `stages` array. The first stage is `delegate`; later stages may be `delegate`, `followup`, `review`, or `rollover`. Each stage has a bounded `input` with a prompt. For example:

```json
{
  "version": 1,
  "title": "Implementation and review",
  "budget": { "maxTotalTokens": 100000, "maxCostUsd": 20 },
  "stages": [
    { "kind": "delegate", "input": { "repository": "/workspace/repo", "title": "Implement", "prompt": "Implement the scoped change" } },
    { "kind": "review", "input": { "prompt": "Review the code snapshot" }, "requires": ["execution", "verification"] },
    { "kind": "followup", "input": { "prompt": "Address reviewed findings" }, "requires": ["execution", "verification", "acceptance"] }
  ]
}
```

Run `PI_MCP_CONFIG=/absolute/config.json node scripts/workflow.mjs create /absolute/plan.json`. The returned `goal-...` ID is used with `status`, `advance`, `cancel`, and `release`. `advance` starts at most one child and can be called again after the child reaches a terminal state. Public status contains only stage kinds, IDs, gates, observed aggregate usage and block reasons. Private state keeps prompts and deterministic request intents at `<stateDir>/workflows/` with mode 0600 files.

Before each submission the workflow takes its goal lock, then the Manager submit lock, revalidates its source and saves an immutable request ID plus payload digest. Manager rechecks the source code, contract, acceptance, and exact request identity under its submit lock while admitting the child. On restart it matches the deterministic request ID and full Manager request hash to a created job before retrying; a followup that automatically became a rollover is recognized. A prepared intent and all source/review job IDs remain cleanup references. Cleanup reads those references while holding its submit lock without acquiring a workflow lock. Corrupt or unsafe workflow state blocks cleanup.

Every later stage waits for the previous source to finish successfully. If that source requested acceptance, later implementation waits for `acceptance.status: accepted`; a review stage may run while that status is `pending_review`. At the final stage, the goal stays at `await_attestation` until the last code-producing job's acceptance is complete. Review prose is never treated as approval. A caller must use the separate digest-bound `attestReview` API when that contract requires it. A selected acceptance gate is not satisfied by `not_requested`.

Aggregate token and cost limits check observed usage between stages. Each child, including review and a terminal cancelled child, is counted once. Every assistant response must supply a valid measurement for the configured dimension; a partial positive aggregate cannot satisfy the budget. Missing or legacy-unproven dimensions are reported as `null` and block the configured budget. A running child can overshoot the remaining allowance; the budget is not a hard provider spend cap. `cancel` saves intent before calling Manager and replays delivery on restart. `release` rechecks final acceptance and writes its released state under the Manager submit lock after confirming no child is active. Raw sessions and job artifacts remain under Manager ownership.
