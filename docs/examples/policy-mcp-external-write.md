# Example policy — MCP external write approval

Status: example only; not deployed.

Tujuan policy ini adalah mengizinkan operasi read secara otomatis, tetapi
mengharuskan persetujuan manusia untuk capability MCP yang mengubah sistem
eksternal.

```rego
package made.hard

default allow := true

# The production policy set should use the shared base.rego decision shape.
# This example is intentionally illustrative and is not copied into
# MADE/policies/hard/ automatically.
deny contains {"reason": "external write requires human approval"} if {
    input.task.intent == "external_write"
    input.candidate.kind == "tool"
    input.candidate.operation in {"create", "update", "delete", "publish", "send", "deploy"}
    not input.task.approval_granted
}
```

Runtime contract:

1. Classifier marks the request as `external_write` and identifies the
   capability.
2. MADE excludes the write capability or returns
   `requires_human_approval: true`.
3. Orchestrator may prepare a draft, but stops before the MCP call.
4. After explicit approval, the orchestrator performs a fresh MADE decision
   with `approval_granted: true` and an idempotency key.
5. The connector executes the operation and the orchestrator verifies the
   result.

The field names are illustrative. Before activation, they must be aligned
with the canonical `Task`, `DecisionCandidate`, and shared Rego input schema,
then covered by OPA tests and an end-to-end approval test.
