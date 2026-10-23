# Claude delegator parity

The installed `claude_delegator` seven-tool service is the baseline delegation reference. Pi and Claude authentication and model names are different. The table maps those seven baseline operations; Pi's completion APIs extend beyond them.

| Claude tool | Pi tool | Behavior |
| --- | --- | --- |
| `claude_health` | `pi_health` | Version, configured roots, capacity and credential presence; no model request. Pi also reports `rg`/`fd` availability. |
| `claude_delegate` | `pi_delegate` | New branch/worktree from committed ref, asynchronous job ID, dirty-source warning and idempotent `request_id`. Pi requires provider and model from config or call. |
| `claude_status` | `pi_status` | Progress and optional bounded wait; running is not completion. |
| `claude_result` | `pi_result` | Bounded result/error, usage, permission denials and diff preview. Separate artifact APIs page eligible changed and new file content with digests. |
| `claude_list` | `pi_list` | Recent jobs across MCP connections. |
| `claude_cancel` | `pi_cancel` | Cancel queued work or abort a worker; preserve worktree/artifacts. Uncertain process ownership quarantines the job for evidence-based recovery. |
| `claude_followup` | `pi_followup` | New job in the same worktree; resume the recorded Pi session, or start fresh if no session was recorded. Missing recorded sessions fail. Parent artifacts remain unchanged. |

Pi policy uses read-only or implement mode with exact command allowlisting. No arbitrary MCP shell capability is exposed. Pi supports corporate-compatible model endpoints through its `models.json`, proxy and CA environment; actual company credentials and endpoint connectivity require validation in that environment. A copied OAuth login is not guaranteed independent of the source login's refresh lifecycle.

Pi additionally supports bounded queues, separate verification status, persistent events, steering, session/worktree forks, approved MCP, offline materials, artifact pages, and guarded recovery/cleanup. See the [runtime guide](completion-runtime.md), [artifact and offline guide](offline-artifacts.md), and [approved MCP guide](approved-mcp.md) for configuration and limits. This mapping does not claim parity with every Claude Code product feature or the full MCP protocol. Actual corporate endpoint acceptance and per-user OS isolation remain separate work. See the [operations guide](operations.md) for operator cautions.
