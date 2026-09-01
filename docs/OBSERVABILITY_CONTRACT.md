# Observability and Workspace contract

The Workspace operations hub is intentionally read-only and consumes these
future-compatible shapes. API implementations may return additional fields.

## Runtime status

`GET /api/operations/status`

```json
{
  "generated_at": "2026-09-01T00:00:00.000Z",
  "services": [{
    "id": "made",
    "name": "MADE policy engine",
    "status": "ready",
    "latency_ms": 12,
    "version": "string|null",
    "capabilities": ["decide"]
  }]
}
```

Valid status values are `ready`, `degraded`, `offline`, and `preview`.
Credentials, tokens, and transport secrets must never occur in this response.

## Workflow runs

`GET /api/operations/runs?limit=25&status=running`

```json
{
  "runs": [{
    "workflow_id": "string",
    "run_id": "string",
    "status": "queued|running|waiting_approval|completed|failed|cancelled",
    "actor_id": "string|null",
    "intent": "string|null",
    "started_at": "string|null",
    "updated_at": "string",
    "duration_ms": 0,
    "step_count": 0,
    "cost_usd": 0,
    "error_code": "string|null"
  }],
  "total": 0
}
```

`GET /api/operations/runs/:run_id` returns the envelope and step summaries;
step input/output should be redacted or summarized according to policy.

## Approvals and audit

`GET /api/operations/approvals?status=pending` returns `{ approvals, total }`.
An approval item includes `approval_id`, `run_id`, `capability`, `operation`,
`requested_by`, `reason`, `expires_at`, and `status`; never include credentials.

`GET /api/operations/audit?limit=50&actor_id=&organization_id=&correlation_id=`
returns `{ events, total }`. Each event includes `event_id`, `event_type`,
`run_id`, `correlation_id`, `actor_id`, `policy_decision_id`, `policy_version`,
`occurred_at`, `latency_ms`, `outcome`, and redaction-safe `metadata`.

Persistence and policy agents should treat these as additive contracts: absent
optional fields should render as unavailable, not as a successful operation.
