# MCP credential boundary

Credential aplikasi hanya boleh hidup di boundary MCP transport. Orchestrator,
MADE, model prompt, Open WebUI valves, audit event, dan workflow result tidak
boleh menerima atau mencatat secret.

## Allowed flow

```text
secret manager / process environment
  → MCP transport factory
  → MCP server
  → typed capability result
  → orchestrator
```

The connector manifest contains server identity, capabilities, scopes, and
approval metadata. It never contains an API key or OAuth token.

## Rules

- Pass credentials only when constructing the transport connection.
- Do not include credentials in `McpCall.args`.
- Do not serialize transport configuration into prompts or workflow evidence.
- Redact authorization headers, cookies, tokens, and secret-like values before logging.
- Return structured transport errors without the upstream response body when it
  may contain credential material.
- Rotate credentials outside the orchestrator; active runs use the current
  transport credential and must not persist it.
- Connector health checks must authenticate through the transport boundary and
  expose only `healthy`, `latency`, and sanitized error code.

## Review checklist

- [ ] Manifest has no secret fields.
- [ ] Adapter schema rejects secret-shaped arguments.
- [ ] Audit metadata contains no prompt, headers, cookies, or tokens.
- [ ] Failure fixtures assert secret redaction.
- [ ] Connector scopes are least-privilege and policy-approved.
