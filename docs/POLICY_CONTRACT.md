# External operation policy contract

Every MCP invocation carries an `operation` (`read`, `draft`, `create`,
`update`, `delete`, `publish`, `send`, or `deploy`). The executor treats the
last six values as external writes. A write is denied when the policy authorizer
is missing or MADE is unavailable.

Immediately before opening the MCP transport, the executor calls:

```ts
authorize({
  connector_id, capability, operation,
  run_id, actor_id, organization_id, correlation_id,
  approval_granted, idempotency_key
}) => ({
  allowed, requires_approval, reason,
  decision_id, policy_version
})
```

`allowed` must be true for the exact connector/capability pair. If approval is
required, a matching approval must be present or the approval callback must
return true. Credentials are resolved only by the transport boundary.

`idempotency_key` is optional for reads and required by the caller for safe
retries of writes. A completed result is cached by connector, capability, and
key; failed calls are never cached. Audit events contain identifiers and policy
metadata, never arguments or credentials.

Persistence and UI consumers should preserve `run_id`, `correlation_id`, `operation`,
`idempotency_key` (presence only in audit display), approval state,
`decision_id`, and `policy_version` when displaying or storing a run.
