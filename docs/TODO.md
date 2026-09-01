# ai-workspace TODO

Status: active backlog · 2026-09-01

Web search and the basic chat surface are treated as the current baseline.
The next phase builds the orchestration and MCP infrastructure without adding
any application-specific connector yet.

## P0 — Workflow foundation

- [x] Define the orchestrator run state machine (`queued`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled`).
- [x] Persist `workflow_id`, `run_id`, actor, intent, classification, policy decision, and timestamps.
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
- [x] Add connector capability discovery without exposing credentials.
- [x] Add fixture MCP transport for deterministic contract tests.
- [x] Add malformed argument, malformed result, timeout, and disconnect tests.
- [x] Document credential flow: credentials remain exclusively at MCP boundary.

## P0 — Policy boundary

- [x] Define policy input for actor, organization, data classification, operation, connector, and capability.
- [x] Separate classifier hints from MADE authorization decisions.
- [x] Re-check MADE before every external write or destructive capability.
- [x] Enforce approval, scope, budget, and max-step decisions in the executor.
- [x] Add policy decision IDs and policy versions to decision/audit records.
- [x] Add policy simulation and policy diff checks before deployment.
- [x] Add deny-by-default behavior when MADE or policy service is unavailable.

## P1 — Audit and observability

- [x] Add process-local audit sink for model and tool decisions.
- [x] Persist audit events with redaction-safe metadata.
- [x] Add correlation IDs across OpenWebUI, orchestrator, and MADE.
- [x] Record connector decisions with decision ID, policy version, latency, and outcome.
- [x] Add metrics for completion, failure, denial, approval, retries, latency, and cost.
- [x] Add an audit query API with actor/organization/correlation filters.

## P1 — Workspace operations UI

- [x] Replace Workspace model landing page with application/workflow hub.
- [x] Add connector infrastructure status cards.
- [x] Add MCP server health and capability inspection views.
- [x] Add workflow run history and run detail views.
- [x] Add approval inbox and approval detail view.
- [x] Add audit event viewer.
- [x] Add usage, latency, and cost summaries.

## P1 — Reliability and security

- [x] Add authentication and authorization between internal services (shared boundary primitive; production proxy wiring remains deployment work).
- [x] Add secret rotation and secret-manager integration boundary.
- [x] Add SSRF, private-network, payload-size, and URL validation guards.
- [x] Add per-user and per-organization rate limits (fixed-window primitive; shared-store wiring remains deployment work).
- [x] Add restart recovery for running and waiting-approval workflows.
- [x] Add database migrations, backup, and restore runbook.

## P2 — Agent runtime

- [x] Define manager-agent and specialist-agent contracts.
- [x] Restrict specialist context and capabilities to an approved manifest.
- [x] Add typed handoff envelope and verifier contract (synthesizer execution remains).
- [x] Add bounded multi-agent execution only after single-agent workflows pass evaluation.
- [x] Add agent-level cost, latency, and policy metrics.

## P2 — Controlled external actions

- [x] Define read, draft, create, update, delete, publish, send, and deploy operation semantics.
- [x] Add explicit approval gates for external side effects.
- [x] Add idempotency keys and duplicate-execution protection.
- [x] Add post-action verification and compensating-action metadata.
- [x] Add dry-run mode for every write-capable workflow.

## P2 — Evaluation and documentation

- [x] Build deterministic workflow and MCP contract test suite.
- [x] Add MADE baseline evaluation for cost, quality, latency, denial, and approval.
- [x] Add failure-injection scenarios for model, policy, transport, and connector failures.
- [x] Update PRD and architecture docs after runtime contracts stabilize.
- [ ] Rewrite the final system design only after the preceding runtime work is complete.

## Explicit non-goals for this phase

- No Figma, Google Ads, or other application connector implementation yet.
- No unrestricted autonomous agent spawning.
- No generic credential proxy exposing arbitrary MCP methods.
- No automatic destructive or publish actions.
