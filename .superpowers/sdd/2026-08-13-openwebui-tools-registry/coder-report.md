# Coder Report — D1: Open WebUI Tools Registry

**Commit:** `61defe6` (branch `openwebui-tools-documents`, worktree `.worktrees/openwebui-tools-documents/`, base `a4b7470`)
**Tests:** 118/118 pass (npm test), `npx tsc --noEmit` clean

## What shipped

1. **`src/openwebui-provision-tools.ts`** — idempotent provisioning of `web_search` + `scrape` as native Open WebUI Tools. Each tool is Python that POSTs to this project's `/api/web-search` / `/api/scrape` routes. Tool `Valves` class exposes `backend_url` (default `http://app:3000`, the compose `app` service as seen from the open-webui container; host-dev overrides via `OPENWEBUI_BACKEND_URL`). Per tool: GET → create on 404 / update on content diff / skip when identical; **valves are always re-applied**, even for up-to-date tools, so a deployment's backend URL can't go stale.
2. **`src/server.ts`** — added `POST /api/scrape` (400 on invalid/missing `url`, 500 with message on executor throw), 4th injectable `createServer` param `scrapeExecutorFn` (default `callScrape`), mirroring the existing web-search pattern.
3. **`tests/openwebui-provision-tools.test.ts`** — 6 tests (create both / update diff / skip up-to-date / signin failure / create failure partial actions / Python-source structural sanity).
4. **`tests/server.test.ts`** — 3 new /api/scrape tests.
5. **CLAUDE.md** — Tools registration section; **`.env.example`** — `OPENWEBUI_BACKEND_URL` (commented).

## Deviations from spec/plan (with justification)

1. **`/api/scrape` did not exist in the codebase** (grep across `src/` + `genoffice/` = 0 matches) — the spec/plan asserted the backend "already has" it. Added the route server-side rather than wiring the tool to a dead endpoint. `callScrape` (Scrapling MCP with SSRF guard `assertUrlAllowed`) is the real executor; the route returns `{content}` (markdown).
2. **URLs in the spec were wrong for Docker** — spec said tools call `localhost:3000`; from inside the open-webui container that resolves to the container itself, not the backend. Actual topology (verified against `docker-compose.yaml`): open-webui → backend at `http://app:3000`; host browser reaches both via localhost ports. Hence the `backend_url` valve + default.
3. **Tool update endpoint is POST** `/api/v1/tools/id/{id}/update` (not PUT) — matched the actual router.

## Known issues / edge cases

- Valves payload is the dict itself (`{backend_url: ...}`), **not** wrapped in `{valves: {...}}` — verified against the router's `form_data: dict` signature.
- Python sources are validated structurally in tests only; real syntax check happens when Open WebUI loads the tool (no python interpreter in the test env).
- `web_search` passes `language` to `/api/web-search`; the backend route only reads `query` + `maxResults` — the extra field is ignored server-side, no harm.
- Manual verification (provisioning against a live Open WebUI + a real search/scrape round-trip) not yet done — needs the full docker stack up.

## Ready for review

Task review + final whole-branch review per coder agent spec.
