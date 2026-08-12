# Deploy Open WebUI as the Primary Chat App — Design

## Goal

Get Open WebUI (cloned at `open-webui/`, a SvelteKit + Python/FastAPI chat
app) running as a new service in this project's own `docker-compose.yaml`,
reachable and usable for a basic chat, with zero application-code changes
to Open WebUI itself. This is Sub-project A' of a larger, previously-scoped
arc (see `[[project_openwebui_ui_overhaul]]` memory / the conversation this
spec came from): Open WebUI becomes the primary user-facing app going
forward; this project's own Node server (`src/server.ts`) becomes an
internal backend that later sub-projects wire Open WebUI up to (MADE
routing, a Policy workspace category, GenOffice/tool integration — all
explicitly out of scope here).

## Non-goals

- No MADE integration — chat completions in this sub-project go straight
  from Open WebUI to whatever LLM connection the user configures through
  its own Admin Settings UI, same as using Open WebUI standalone. Routing
  through MADE's `/decide` is Sub-project B'.
- No Ollama — this deployment disables Open WebUI's Ollama integration
  entirely; only API-based providers (configured by the user through Open
  WebUI's own Connections UI after first login, not via env vars or this
  plan) are in scope.
- No DeepSeek (or any provider) API key wired through this project's own
  `.env` or `docker-compose.yaml` — the user configures provider
  connections themselves, inside Open WebUI, after the container is up.
  This plan introduces zero LLM-provider secrets.
- No GenOffice `/document` link/integration inside Open WebUI's UI — still
  reached at its existing separate URL. That's Sub-project D'.
- No Postgres, no OAuth, no reverse proxy/TLS (matches this project's
  existing all-`127.0.0.1`-bound, no-cloud-deploy-yet posture).
- No changes to Open WebUI's own source code — this is a pure
  infrastructure/deployment task. If Sub-project B'/C'/D' later need to
  modify its backend, that's handled when those are brainstormed.

## Architecture

Add a new `open-webui` service to this project's existing
`docker-compose.yaml`, built from `open-webui/Dockerfile` (the repo's own
multi-stage build — compiles the SvelteKit frontend and packages it into
the same image as the FastAPI backend; confirmed during research, no
changes needed to the Dockerfile itself).

- **Build context:** `./open-webui` (the cloned repo directory), using its
  own `Dockerfile` — analogous to how `made` already builds from
  `./MADE` in the existing compose file.
- **Port:** internal container port is fixed at `8080` (Open WebUI's own
  default). Expose externally on `127.0.0.1:3001:8080` — port `3000` is
  already this project's own `app` service; `3001` is free. Matches the
  existing convention of binding every service to `127.0.0.1` only (no
  service is reachable outside the host).
- **Ollama disabled:** `ENABLE_OLLAMA_API=false` — no Ollama service is
  added to this compose file, and Open WebUI is told not to probe for one.
  (Confirmed during research: without this, Open WebUI's default
  `ENV=prod` behavior auto-probes for an Ollama instance at
  `host.docker.internal:11434`+ a port-fallback scan — explicitly turning
  the integration off avoids relying on that probe succeeding or failing
  silently.)
- **Database:** SQLite, Open WebUI's own default — no `DATABASE_URL` env
  var is set, so it falls back to `sqlite:///<data-dir>/webui.db`
  automatically. No Postgres service is added.
- **Persistence:** a new named volume (`open-webui-data`, following the
  existing volume-naming style already used elsewhere in the compose file)
  mounted at `/app/backend/data` — this is where the SQLite file, uploaded
  files, and any other Open WebUI state lives. Without this, all data
  (including the admin account created on first login) is lost on every
  container recreation.
- **`WEBUI_SECRET_KEY`:** a new required var in `.env`/`.env.example`, NOT
  an LLM API key — it's Open WebUI's own JWT-signing secret for its login
  sessions (analogous to a Rails `secret_key_base` or Express session
  secret). Set to a fixed, real value rather than left empty, so container
  recreation doesn't invalidate every logged-in session. `.env.example`
  gets a comment explaining what it is (to prevent the same "is this an
  LLM key?" question resurfacing for a future reader).
- **No `depends_on`** on any other service in this compose file — Open
  WebUI doesn't need `searxng`/`scrapling`/`made`/`app` for this
  sub-project's scope (those integrations are future sub-projects).

## First-run / setup

No manual setup beyond `docker compose up --build open-webui`. Visiting
`http://localhost:3001` presents Open WebUI's own sign-up screen; the
first account created is automatically granted admin rights (confirmed
during research — this is Open WebUI's own built-in behavior, not
something this plan implements). From there, the user configures an LLM
provider connection themselves via Open WebUI's Admin Settings — outside
this plan's scope, per Non-goals.

## Error handling

This plan makes no application-code changes, so there's no new error
handling to design — Open WebUI's own existing behavior (e.g. what happens
if no provider is configured yet, first-run edge cases) is unmodified.
The one thing worth confirming during implementation: the container
actually starts cleanly and the healthcheck (`Dockerfile`'s own
`HEALTHCHECK` hitting `/health`, unmodified) reports healthy, since
`ENABLE_OLLAMA_API=false` is a behavior change from the tool's own default
compose file and should be confirmed not to break startup.

## Testing

No new application code exists to unit-test — verification is manual,
consistent with how this project has already treated pure
infrastructure/deployment changes:

1. `docker compose up --build open-webui` — confirm the image builds and
   the container reaches a healthy state.
2. Visit `http://localhost:3001` — confirm the sign-up screen loads.
3. Create the first account — confirm it lands in the app as an admin
   (Open WebUI's Admin Settings should be visible/accessible).
4. Restart the container (`docker compose restart open-webui`, or
   `down`/`up` without removing the volume) — confirm the account and any
   settings persist (proves the volume mount is correct).
5. Confirm no Ollama-related errors/probing noise appears in
   `docker compose logs open-webui` given `ENABLE_OLLAMA_API=false`.

## Out of reach

- MADE routing (Sub-project B').
- Policy workspace category (Sub-project C').
- GenOffice `/document` linkage, tool integration (Sub-project D').
- Postgres, OAuth, reverse proxy/TLS, cloud deployment.
