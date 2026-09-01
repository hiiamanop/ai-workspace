# ai-workspace TODO

Status: active backlog · 2026-09-01

Web search and the basic chat surface are treated as the current baseline.
The next phase builds the orchestration and MCP infrastructure without adding
any application-specific connector yet.

## P0 — Workflow foundation

- [x] Define the orchestrator run state machine (`queued`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled`).
- [ ] Persist `workflow_id`, `run_id`, actor, intent, classification, policy decision, and timestamps.
- [x] Enforce maximum steps, timeout, retries, token budget, and cost budget in one runtime guard.
- [x] Add cancellation, resume, and retry semantics with idempotent run transitions.
- [x] Add structured workflow errors and a final verification stage.
- [x] Add contract tests for state transitions and budget exhaustion.

## P0 — MCP infrastructure (connector-agnostic)

- [x] Define and validate versioned connector manifests.
- [x] Define a connector registry and capability allowlist.
- [x] Define a typed workflow/run envelope.
- [x] Add a generic MCP executor boundary with scope and approval checks.
- [x] Define typed capability schemas for request and response validation.
- [x] Add transport abstraction for Streamable HTTP and stdio MCP servers.
- [x] Add per-server timeout, retry, concurrency, and circuit-breaker policy.
- [x] Add MCP server health state and readiness checks.
- [ ] Add connector capability discovery without exposing credentials.
- [x] Add fixture MCP transport for deterministic contract tests.
- [x] Add malformed argument, malformed result, timeout, and disconnect tests.
- [ ] Document credential flow: credentials remain exclusively at MCP boundary.

## P0 — Policy boundary

- [x] Define policy input for actor, organization, data classification, operation, connector, and capability.
- [x] Separate classifier hints from MADE authorization decisions.
- [ ] Re-check MADE before every external write or destructive capability.
- [x] Enforce approval, scope, budget, and max-step decisions in the executor.
- [x] Add policy decision IDs and policy versions to decision/audit records.
- [ ] Add policy simulation and policy diff checks before deployment.
- [ ] Add deny-by-default behavior when MADE or policy service is unavailable.

## P1 — Audit and observability

- [x] Add process-local audit sink for model and tool decisions.
- [x] Persist audit events with redaction-safe metadata.
- [x] Add correlation IDs across OpenWebUI, orchestrator, and MADE.
- [x] Record connector decisions with decision ID, policy version, latency, and outcome.
- [ ] Add metrics for completion, failure, denial, approval, retries, latency, and cost.
- [x] Add an audit query API with actor/organization/correlation filters.

## P1 — Workspace operations UI

- [x] Replace Workspace model landing page with application/workflow hub.
- [ ] Add connector infrastructure status cards.
- [ ] Add MCP server health and capability inspection views.
- [ ] Add workflow run history and run detail views.
- [ ] Add approval inbox and approval detail view.
- [ ] Add audit event viewer.
- [ ] Add usage, latency, and cost summaries.

## P1 — Reliability and security

- [ ] Add authentication and authorization between internal services.
- [ ] Add secret rotation and secret-manager integration boundary.
- [ ] Add SSRF, private-network, payload-size, and URL validation guards.
- [ ] Add per-user and per-organization rate limits.
- [ ] Add restart recovery for running and waiting-approval workflows.
- [ ] Add database migrations, backup, and restore runbook.

## P2 — Agent runtime

- [ ] Define manager-agent and specialist-agent contracts.
- [ ] Restrict specialist context and capabilities to an approved manifest.
- [ ] Add typed handoff envelope and verifier/synthesizer stages.
- [ ] Add bounded multi-agent execution only after single-agent workflows pass evaluation.
- [ ] Add agent-level cost, latency, and policy metrics.

## P2 — Controlled external actions

- [ ] Define read, draft, create, update, delete, publish, send, and deploy operation semantics.
- [ ] Add explicit approval gates for external side effects.
- [ ] Add idempotency keys and duplicate-execution protection.
- [ ] Add post-action verification and compensating-action metadata.
- [ ] Add dry-run mode for every write-capable workflow.

## P2 — Evaluation and documentation

- [ ] Build deterministic workflow and MCP contract test suite.
- [ ] Add MADE baseline evaluation for cost, quality, latency, denial, and approval.
- [ ] Add failure-injection scenarios for model, policy, transport, and connector failures.
- [ ] Update PRD and architecture docs after runtime contracts stabilize.
- [ ] Rewrite the final system design only after the preceding runtime work is complete.

## Explicit non-goals for this phase

- No Figma, Google Ads, or other application connector implementation yet.
- No unrestricted autonomous agent spawning.
- No generic credential proxy exposing arbitrary MCP methods.
- No automatic destructive or publish actions.
