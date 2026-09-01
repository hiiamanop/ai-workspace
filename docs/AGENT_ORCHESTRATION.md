# Agent orchestration architecture

Status: implementation roadmap · 2026-09-01

## Goal

`ai-workspace` will orchestrate application connectors through MCP. Google
Ads, Figma, and research are examples only; the platform must support adding
any MCP-compatible application without changing the core orchestrator.
OpenWebUI remains the user-facing surface; OmniRouter provides models; MADE
remains the policy and multi-objective decision gate.

## Boundary between components

```text
OpenWebUI
  -> manager/orchestrator
       -> classifier (intent, complexity, required capabilities)
       -> MADE /decide (model, specialist, MCP tools, approval)
       -> specialist agent as a constrained capability
            -> MCP server for one application
       -> verifier/synthesizer
  -> user-facing answer
```

The manager owns the response shown to the user. Specialists do not receive
unbounded access to other specialists or arbitrary MCP tools. A specialist is
an adapter plus a bounded workflow for one application domain.

## Agent contract

Every specialist must declare a versioned manifest:

```json
{
  "id": "figma",
  "version": "0.1.0",
  "description": "Inspect and update Figma files",
  "capabilities": ["read_file", "inspect_components", "comment"],
  "mcp_server": "mcp-figma",
  "required_scopes": ["files:read"],
  "destructive_actions": ["comment", "update_file"],
  "approval_required": ["update_file"]
}
```

The manifest is metadata, not authorization. MADE evaluates the concrete
candidate/tool, user/org context, data classification, and requested action.
The MCP adapter validates arguments and result schemas before returning data
to the manager.

## Connector model

An application integration is a specialist connector, not a special case in
the core runtime. The connector owns the mapping between a typed workflow and
one MCP server. Adding a connector should require only a manifest, adapter,
schemas, policy metadata, and tests.

## Example specialists

1. `research`: web search and scraping; read-only and suitable as the first
   end-to-end specialist.
2. `figma` (example): inspect files and components first; write/comment actions
   require explicit approval.
3. `google_ads` (example): read campaigns, metrics, and recommendations first;
   budget, bid, campaign, and publish mutations require approval and
   idempotency keys.

Google Ads and Figma should not be implemented as generic “autonomous agents”.
Start with typed workflows such as `inspect_campaign`, `draft_ad_copy`,
`inspect_figma_file`, and `draft_component_change`. Add write operations only
after read-only workflows have traces and regression fixtures.

## Execution rules

- Classifier proposes an intent and capabilities; it never authorizes an
  action.
- MADE is called before selecting a specialist and again before any
  destructive or external side effect.
- The server enforces max steps, timeout, token/cost budget, and retry policy.
- MCP credentials stay in the MCP server boundary; they are never copied into
  model prompts, OpenWebUI tool valves, or logs.
- Tool arguments and results are schema-validated. Errors are returned as
  structured evidence; the model must not fabricate a successful action.
- Every run receives a `workflow_id`, `agent_id`, `mcp_server`, and audit
  events containing policy version, decision id, latency, and outcome.

## Delivery sequence

1. Stabilize the current research workflow (`web_search` -> `scrape` -> verify).
2. Introduce a typed agent manifest/registry and workflow run envelope.
3. Move research into the first specialist adapter without changing the user
   experience.
4. Add an MCP gateway abstraction with per-server allowlists and health state.
5. Add the first external read-only connector selected from the user's actual
   MCP integrations, with fixtures and health checks.
6. Add additional connectors using the same manifest/adapter contract; Figma
   and Google Ads are optional examples, not hard-coded roadmap requirements.
7. Add approval-gated draft/write workflows, idempotency, and audit review.
8. Measure completion, policy violations, cost, latency, tool failures, and
   approval/refusal rates before enabling more autonomy.

## Non-goals for the first iteration

- No unrestricted multi-agent debate or agent-to-agent spawning.
- No generic credential proxy that exposes all MCP methods to every model.
- No automatic campaign publishing or Figma file mutation without approval.
- No hidden provider-specific agent runtime behind OpenWebUI.
