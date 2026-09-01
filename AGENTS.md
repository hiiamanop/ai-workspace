# AGENTS.md — ai-workspace

## Mission

`ai-workspace` is a self-hosted, policy-governed AI orchestration layer. Open
WebUI is the user-facing surface, OmniRouter is the OpenAI-compatible model
gateway, MADE is the policy and multi-objective decision engine, and MCP
connectors expose external applications through bounded capabilities.

The core runtime must remain connector-agnostic. A new application is added
through a manifest, adapter, schemas, scopes, policy metadata, and tests; do
not hard-code application-specific logic into the orchestrator.

## Architecture rules

- Classifier proposes intent, complexity, data classification, and required
  capabilities; it never authorizes an action.
- MADE must approve model, agent/connector, and tool decisions before
  execution. Re-check before destructive or external write actions.
- OpenWebUI native connections and native Tools are the primary path.
  `ENABLE_AUTO_PIPE=true` enables the legacy direct-upstream Auto Pipe only as
  an explicit fallback.
- MCP credentials stay at the MCP boundary and never enter prompts, logs, or
  OpenWebUI tool valves.
- Enforce schemas, scopes, timeouts, max steps, token/cost budgets, retries,
  approval gates, and audit events in code.
- Never fabricate tool results or URLs. Return structured failures to the
  model and user.

## Commands

```bash
npm install
npm run dev
npm run build
npm test
npx tsc --noEmit
node --import tsx --test tests/<file>.test.ts

# MADE (normally use its Docker/venv environment)
cd MADE && .venv/bin/python -m uvicorn api.main:app --port 8000
```

Docker runs `app`, `made`, `open-webui`, `searxng`, and `scrapling` from
`docker-compose.yaml`. Rebuild with `docker compose up --build` after source
or dependency changes. Provider keys belong only in `.env`; never commit or
print them.

## Change workflow

Read the relevant source, PRD, and tests before editing. Make the smallest
coherent change, add regression coverage, run focused tests plus typecheck,
and report any unavailable dependency or external service explicitly. Do not
rewrite the final system design until all runtime behavior and connector
contracts are stable; system-design redesign is the final project phase.

After non-trivial work, update the dated project note in the configured
Obsidian vault when that path is available. Do not include secrets or raw
confidential data in notes.

## Documentation map

- `docs/PRD.md` — product scope and staged roadmap.
- `docs/AGENT_ORCHESTRATION.md` — generic MCP connector architecture.
- `docs/2026-09-01-ai-orchestration-research.md` — research rationale.
- `docs/DESIGN_SYSTEM.md` — current confidentiality design; redesign last.
- `MADE/docs/PRD_MADE.md` — MADE research/product scope.
