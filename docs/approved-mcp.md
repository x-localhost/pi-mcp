# Administrator-approved MCP in the internal Pi profile

Approved MCP is disabled by default. The agent still starts Pi with `--no-mcp`; no repository or user MCP file is loaded. An administrator declares each server and every model-visible tool in `/etc/pi-internal/config.json`. The trusted policy extension registers only those tools as `mcp__<server-id>__<tool-name>`. The same names must be present in Pi's startup `--tools` allowlist, which the core worker builds from the normalized profile. `reviewTools` is an explicit administrator allowlist for review mode; a server's read-only annotation does not grant review access.

These examples use documentation-only private addresses, hostnames and environment variable names. Put credential values only in the owner-private gateway environment file, never in either JSON file or a repository. The configured hostname is used for HTTPS certificate verification and SNI; the configured RFC1918 IPv4 address is used for the connection without DNS lookup.

## Fixed private HTTPS MCP endpoint

This complete agent/gateway pair declares one read tool. The backend must implement the supported stateless JSON subset and return exactly the declared tool name, description and input schema during discovery. The CA file must exist at the configured path. The gateway environment file must define `CORP_LLM_API_KEY` and `CORP_DOCS_MCP_TOKEN` as owner-private variables.

`/etc/pi-internal/config.json`:

```json
{
  "piPath": "/usr/local/bin/node",
  "piArgs": ["/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"],
  "stateDir": "/var/lib/pi-mcp",
  "allowedRoots": ["/workspace"],
  "maxConcurrent": 2,
  "defaultTimeoutSeconds": 1800,
  "maxTimeoutSeconds": 7200,
  "defaultMaxTurns": 30,
  "provider": "corporate",
  "model": "approved-model",
  "modelsFile": "/etc/pi-internal/models.json",
  "allowedCommands": [],
  "envAllowlist": [],
  "approvedMcp": {
    "servers": [{
      "id": "docs",
      "transport": "internal-http",
      "backendAttested": true,
      "route": "/internal-mcp/docs",
      "tools": [{
        "name": "read",
        "description": "Read a document",
        "inputSchema": {
          "type": "object",
          "properties": { "path": { "type": "string", "minLength": 1, "maxLength": 128 } },
          "required": ["path"],
          "additionalProperties": false
        }
      }],
      "reviewTools": ["read"]
    }]
  }
}
```

`/etc/pi-internal/gateway.json`:

```json
{
  "upstreamUrl": "https://llm.corp.internal/v1/chat/completions",
  "upstreamAddress": "10.20.30.10",
  "model": "approved-model",
  "caFile": "/etc/pi-internal/ca.pem",
  "headers": { "Authorization": "Bearer $CORP_LLM_API_KEY" },
  "limits": { "maxOutputTokens": 4096, "maxN": 1, "requestsPerMinute": 60 },
  "mcpServers": [{
    "id": "docs",
    "upstreamUrl": "https://docs.corp.internal/mcp",
    "upstreamAddress": "10.20.30.20",
    "caFile": "/etc/pi-internal/ca.pem",
    "headers": { "Authorization": "Bearer $CORP_DOCS_MCP_TOKEN" },
    "backendAttested": true,
    "tools": [{
      "name": "read",
      "description": "Read a document",
      "inputSchema": {
        "type": "object",
        "properties": { "path": { "type": "string", "minLength": 1, "maxLength": 128 } },
        "required": ["path"],
        "additionalProperties": false
      }
    }]
  }]
}
```

The agent's fixed route is `/internal-mcp/docs`; it cannot choose the gateway's upstream path. The host preflight requires the agent and gateway tool declarations to match and requires the configured CA at `/etc/pi-internal/ca.pem`. `backendAttested: true` is an administrator assertion that the private backend itself is internal-only. It is **not** proof of the backend's own network isolation or egress policy; that requires independent backend controls.

## Packaged stdio MCP server

This second complete pair runs a server packaged in the agent image. The example assumes an administrator built `/app/approved-mcp/docs-server.mjs` into the image as a root-owned, non-group/world-writable file. Every ancestor directory and the executable path must also meet that ownership and mode requirement, with no symlinks or dot components. Discovery must report the pinned declaration below. `MCP_DOC_ROOT` is a non-secret explicit child environment value; the stdio server does not inherit Pi or gateway credentials.

`/etc/pi-internal/config.json`:

```json
{
  "piPath": "/usr/local/bin/node",
  "piArgs": ["/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"],
  "stateDir": "/var/lib/pi-mcp",
  "allowedRoots": ["/workspace"],
  "maxConcurrent": 2,
  "defaultTimeoutSeconds": 1800,
  "maxTimeoutSeconds": 7200,
  "defaultMaxTurns": 30,
  "provider": "corporate",
  "model": "approved-model",
  "modelsFile": "/etc/pi-internal/models.json",
  "allowedCommands": [],
  "envAllowlist": [],
  "approvedMcp": {
    "servers": [{
      "id": "docs",
      "transport": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/app/approved-mcp/docs-server.mjs"],
      "cwd": "/app/approved-mcp",
      "env": { "MCP_DOC_ROOT": "/workspace/docs" },
      "tools": [{
        "name": "read",
        "description": "Read a document",
        "inputSchema": {
          "type": "object",
          "properties": { "path": { "type": "string", "minLength": 1, "maxLength": 128 } },
          "required": ["path"],
          "additionalProperties": false
        }
      }],
      "reviewTools": ["read"]
    }]
  }
}
```

`/etc/pi-internal/gateway.json`:

```json
{
  "upstreamUrl": "https://llm.corp.internal/v1/chat/completions",
  "upstreamAddress": "10.20.30.10",
  "model": "approved-model",
  "caFile": "/etc/pi-internal/ca.pem",
  "headers": { "Authorization": "Bearer $CORP_LLM_API_KEY" },
  "limits": { "maxOutputTokens": 4096, "maxN": 1, "requestsPerMinute": 60 },
  "mcpServers": []
}
```

The matching `/etc/pi-internal/models.json` remains the one-model internal profile: provider `corporate`, base URL `http://127.0.0.1:18080/v1`, API `openai-completions`, placeholder API key `pi-internal-placeholder`, and model ID `approved-model`. Vision is disabled unless the administrator explicitly sets that model's `input` to `["text", "image"]`.

## Bounds, diagnostics and unsupported protocol features

Both transports pin each tool's name, description and input schema at discovery. At most four servers and sixteen tools per server are accepted. Schemas use a bounded reference-free subset; tool arguments are checked locally and at the HTTP gateway. The limits are 16 KiB per schema, 16 KiB per argument object, 32 KiB per tool result, 64 KiB per internal HTTP frame, two concurrent calls per server and a 10-second MCP call deadline. Tool results exposed to Pi contain bounded text only. The gateway enforces one configured model, maximum output tokens and `n`, plus a shared per-minute request bucket for chat and approved HTTP MCP requests. The default bucket is 60; `limits.requestsPerMinute` may be set from 1 to 600. Health checks do not consume it.

The internal HTTP bridge supports only JSON `initialize`, `notifications/initialized`, `ping`, `tools/list`, and declared `tools/call` on a fixed route. It does not support legacy HTTP/SSE, server-sent events, stateful sessions, session IDs, pagination, resource/prompt methods, batches, server callbacks, sampling, elicitation, arbitrary notifications or redirects. Authentication and CA trust stay in the gateway; incoming agent headers and credentials are not forwarded. The isolated agent has network mode `none` and reaches the fixed Unix socket through a loopback relay. A separately operated MCP backend may still have its own egress, so the administrator must verify that separately before attesting it.

Gateway diagnostics expose a generated request ID, elapsed milliseconds, a bounded category (`auth`, `rate_limit`, `tls`, `connect`, `timeout`, `upstream`, or `protocol`), observed HTTP status, and completed/aborted flags. A partial streamed HTTP 200 can be `aborted: true` with a failure category. The audit holds at most 256 records; it does not contain prompts, tool arguments or results, upstream bodies or headers, environment values or credentials. Non-2xx upstream responses and redirects return generic messages rather than upstream content.
