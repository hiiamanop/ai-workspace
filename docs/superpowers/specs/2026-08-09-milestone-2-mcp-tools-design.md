# Design: Milestone 2 — MCP Tools (SearXNG + Scrapling)

Status: approved by user (2026-08-09).
Builds on Milestone 1 (chat core, done — see `docs/superpowers/specs/2026-08-09-ai-workspace-design.md`).

## 1. Goal

Add tool-calling to the chat loop: the model can call `web_search` (via SearXNG) and `scrape` (via Scrapling) when it needs external information, with MADE deciding which tools are allowed per task. Package the whole stack (this app, SearXNG, Scrapling, and MADE) as one `docker-compose.yaml` so it starts with a single command, instead of the three manually-started processes Milestone 1 required.

## 2. Architecture

`docker-compose.yaml` at the `ai-workspace` repo root, 4 services + 1 external dependency:

| Service | Image/build | Role |
|---|---|---|
| `app` | build `./Dockerfile` (Node/TS) | Chat shell; spawns `mcp-searxng` (`ihor-sokoliuk/mcp-searxng`) as a **stdio** child process on startup |
| `searxng` | `searxng/searxng` official image | Search backend. Called by the `mcp-searxng` subprocess over the internal docker network (`http://searxng:8080`), not directly by `app` |
| `scrapling` | build image running `scrapling mcp --http` | Full-page scraping. Exposed via **Streamable HTTP** MCP transport (supported since Scrapling 0.3.6) at `http://scrapling:8000` |
| `made` | build `../MODE/Dockerfile` (new file, added to the `MODE` repo) | Decision engine, exposed at `http://made:8000` |
| *(external)* Ollama | — | Stays on the host (not containerized — GPU/local-model concerns), reached via `host.docker.internal:11434`; needs an `extra_hosts: ["host.docker.internal:host-gateway"]` entry on the `app` service since Linux doesn't map this automatically like Docker Desktop does |

Two different MCP transports are used deliberately: `mcp-searxng` is a lightweight Node-based wrapper meant to run as a local subprocess (stdio is its default and simplest mode, and it stays inside the `app` container so no extra network hop is needed for a fast, simple call). Scrapling needs Python + headless-browser dependencies that don't belong in the Node app image, so it runs as its own container reached over HTTP.

`MADE_URL` changes from `http://localhost:8000` (Milestone 1, manual process) to `http://made:8000` (docker service DNS name) when running under compose; the `.env`/`.env.example` default should reflect whichever way `app` is actually being run.

## 3. Tool-Calling Loop

Extends `handleChat` (`src/chat.ts`):

1. Ask MADE `decision_kind: model_selection` — unchanged from Milestone 1.
2. Ask MADE `decision_kind: tool_selection` with the task's `data_classification` — returns the allowed subset of `{web_search, scrape}` (MADE may return neither, e.g. for `restricted` data).
3. Call the selected model with `tools: [...]` in OpenAI tool-call format (confirmed working end-to-end against `gemma4:12b` via Ollama's `/v1/chat/completions` — it returns real `tool_calls` with `finish_reason: "tool_calls"`).
4. If the reply contains `tool_calls`: dispatch each call to its MCP client —
   - `web_search` → the stdio `mcp-searxng` subprocess
   - `scrape` → an HTTP call to the `scrapling` service's MCP endpoint
   Append each result as a `tool`-role message, then call the model again. Repeat until `finish_reason` is not `tool_calls`.
5. Return the final text reply, plus which tools (if any) were used, for the UI to show.

If MADE returns no allowed tools, skip tool wiring entirely and behave exactly like Milestone 1 (plain model call, no `tools` param).

## 4. Error Handling

- If the `mcp-searxng` subprocess fails to spawn (or dies mid-session), catch it and feed the model an error string as the tool result (`"web_search unavailable: <reason>"`) instead of failing the whole chat request — the model can tell the user search isn't working right now.
- Same pattern for `scrape`: an HTTP failure/timeout to the `scrapling` service becomes a tool-result error string, not a 500.
- ponytail: no retry/backoff on tool-call failures yet — add only if timeouts turn out to be common in practice, not speculatively.

## 5. Testing

- Mock both `decide` calls (model + tool selection), mock provider `complete` to first return a `tool_calls` response then a final-text response on the second call, mock the MCP tool executors (`web_search`, `scrape`) — verify the loop executes the tool, feeds the result back correctly, and returns the final reply.
- One test for "MADE disallows all tools" — verify the tool loop is skipped and behavior matches Milestone 1 exactly (no `tools` param sent to the model).
- One test per MCP client failure path (subprocess spawn failure, HTTP timeout) — verify the error becomes a tool-result string, not an unhandled exception.
- Docker compose itself is verified manually (Task equivalent to Milestone 1's Task 5): `docker compose up`, confirm all 4 services healthy, confirm a chat message that needs a web search actually round-trips through SearXNG.

## 6. Out of Scope (this milestone)

- Ollama containerization — stays external/manual as decided.
- MADE repo changes beyond adding a `Dockerfile` — no logic changes to the thesis codebase.
- Retry/backoff for tool failures (see §4).
- Univer, Nextcloud — unchanged, still Milestones 3–4 per the original design spec.
