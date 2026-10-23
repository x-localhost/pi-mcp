# Claude delegator parity

The installed `claude_delegator` seven-tool service is the feature reference. Pi and Claude authentication and model names are different.

| Claude tool | Pi tool | Behavior |
| --- | --- | --- |
| `claude_health` | `pi_health` | Version, configured roots, capacity and credential presence; no model request. Pi also reports `rg`/`fd` availability. |
| `claude_delegate` | `pi_delegate` | New branch/worktree from committed ref, asynchronous job ID, dirty-source warning and idempotent `request_id`. Pi requires provider and model from config or call. |
| `claude_status` | `pi_status` | Progress and optional bounded wait; running is not completion. |
| `claude_result` | `pi_result` | Bounded result/error, usage, permission denials, tracked patch and untracked inventory. |
| `claude_list` | `pi_list` | Recent jobs across MCP connections. |
| `claude_cancel` | `pi_cancel` | Clear queue, abort and process-group termination; preserve worktree/artifacts. Uncertain cleanup quarantines the job. |
| `claude_followup` | `pi_followup` | New job in the same worktree; resume the recorded Pi session, or start fresh if no session was recorded. Missing recorded sessions fail. Parent artifacts remain unchanged. |

Pi policy uses read-only or implement mode with exact command allowlisting. No arbitrary MCP shell capability is exposed. Pi supports corporate-compatible model endpoints through its `models.json`, proxy and CA environment; actual company credentials and endpoint connectivity require validation in that environment. A copied OAuth login is not guaranteed independent of the source login's refresh lifecycle.

This mapping covers the installed delegation service, not every Claude Code product feature or `claude mcp serve` tool. Quarantined jobs retain their capacity slot and require operator investigation; this version has no MCP unquarantine endpoint. See the [operations guide](operations.md).
