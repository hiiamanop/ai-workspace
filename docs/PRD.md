# PRD — ai-workspace

Status: evolving product definition · 2026-09-01

## Vision

`ai-workspace` is a self-hosted AI operating layer. A user talks to one
OpenWebUI interface; the system selects the appropriate workflow, model, and
MCP application connector, applies policy, executes bounded steps, and returns
an auditable result.

The platform is connector-agnostic. Google Ads, Figma, research, Slack,
Notion, CRM, GitHub, and other applications are examples of integrations, not
special cases in the core runtime.

## Product promise

The user should not need to know which model, provider, tool, MCP server, or
execution order is required. The system should answer directly, research
current information, work with documents, coordinate applications, prepare
drafts, and request approval before external side effects.

## System boundaries

```text
OpenWebUI (UX/auth/files/approval)
  → orchestrator (workflow/run state)
  → classifier (intent/capabilities/complexity)
  → MADE (policy gate + model/tool ranking)
  → model via OmniRouter
  → MCP connector(s) with least-privilege scopes
  → verifier/synthesizer
```

- OpenWebUI owns the primary chat surface and native tool loop.
- OmniRouter is the model gateway; its raw catalog is never an authorization
  boundary.
- MADE is the authority for model, connector, tool, budget, privacy, risk, and
  human-approval decisions.
- The orchestrator owns workflow order, limits, retries, state, and audit.
- MCP servers own application credentials and application-specific transport.

## Core concepts

- **Connector:** an MCP-backed application integration.
- **Capability:** a typed operation exposed by a connector.
- **Workflow:** a bounded sequence of capabilities and model steps.
- **Agent:** a model-driven specialist constrained to a manifest and policy.
- **Run:** one execution identified by `workflow_id` with traceable events.

New connectors provide a versioned manifest, capability schemas, required
scopes, risk/approval metadata, health checks, adapter code, and fixtures.
Core orchestration must not contain vendor-specific branches.

## Policy and governance

Policy is enforced at runtime. Hard constraints cover privacy/redaction, roles
and scopes, prohibited vendors, context capacity, budget ceilings, tool
capability, and approval-required actions. Soft preferences rank candidates by
cost, quality, latency, and business risk. MADE returns the decision,
exclusions, policy version, and approval requirement.

Read operations may run automatically. Draft operations may run with normal
authorization. Write, publish, send, delete, deploy, or budget-changing
operations require explicit approval, an idempotency key, an audit event, and
post-action verification.

## Staged scope

### Stage 1 — governed assistant (current)

- OpenWebUI + OmniRouter connection.
- MADE model and native-tool routing.
- Local classifier for intent, complexity, and tool hints.
- Web search, scraping, memory, knowledge, file, and image tools where
  configured.
- Confidential redaction and context-capacity checks.
- Streaming, citations, fallbacks, and audit-ready decision records.

### Stage 2 — research workflow

Deliver the first complete workflow:

```text
classify → MADE → search → select candidates → scrape → verify → synthesize
```

It must support current information and exact product links without
fabricating URLs, with bounded query retries and structured source evidence.

### Stage 3 — generic MCP platform

- Connector registry and manifest validation.
- MCP transport abstraction and per-server health state.
- Typed workflow/run envelope.
- Capability allowlists and credential isolation.
- Connector discovery without changing the core orchestrator.

### Stage 4 — application connectors

Add the applications users actually need, beginning with read-only workflows.
Each connector is delivered independently with schemas, policy metadata,
fixtures, failure tests, and observability. No specific vendor is required by
the product definition.

### Stage 5 — controlled actions

Add draft/write/publish workflows with approval, idempotency, audit, rollback
or compensating actions, and verification. Multi-agent manager/specialist
coordination is enabled only after single-agent workflows are reliable.

### Stage 6 — final system-design rewrite

Only after runtime behavior, policy contracts, connector registry, and
evaluation results are stable, rewrite the system design to reflect the real
architecture. This is intentionally the last major documentation task.

## Non-goals

- Unrestricted autonomous multi-agent spawning.
- A universal credential proxy exposing every MCP method.
- Automatic destructive actions without approval.
- Hard-coded support for a fixed list of applications.
- Choosing models solely by cheapest or largest.
- Replacing OpenWebUI with a second primary chat surface.

## Success criteria

- Direct questions do not invoke unnecessary tools.
- Research tasks produce evidence and verifiable source links.
- Every model/tool/action decision is policy-checked and traceable.
- Unauthorized or destructive actions are blocked or approval-gated.
- New MCP connectors can be added without core orchestrator changes.
- Cost, latency, completion, failure, approval, and policy-violation metrics are
  measurable per workflow run.
- The system remains usable when a model, connector, or policy service fails.

## Related documents

- `docs/TODO.md` — prioritized implementation backlog.
- `docs/AGENT_ORCHESTRATION.md`
- `docs/2026-09-01-ai-orchestration-research.md`
- `docs/DESIGN_SYSTEM.md` (current design; rewrite last)
- `docs/PRD-confidentiality-pipeline.md`
- `docs/PRD-openwebui-integrations.md`
- `MADE/docs/PRD_MADE.md`
