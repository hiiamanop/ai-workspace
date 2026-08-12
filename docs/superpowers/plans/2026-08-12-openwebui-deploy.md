# Deploy Open WebUI as the Primary Chat App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get Open WebUI (cloned at `open-webui/`) running as a new service in this project's `docker-compose.yaml`, reachable at `http://localhost:3001`, with zero application-code changes to Open WebUI itself.

**Architecture:** Add an `open-webui` service to the existing `docker-compose.yaml`, building from `open-webui/Dockerfile` (its own multi-stage build, unmodified) — same pattern already used for the `made` service building from `./MADE`. No Ollama, no Postgres, no LLM provider secrets wired through this project's `.env` — the user configures a provider connection themselves via Open WebUI's own Admin Settings after first login.

## Global Constraints

- No changes to any file under `open-webui/` except removing its nested `.git` (see Task 1, Step 1) — this is a pure deployment/config task, not an application-code task.
- No LLM provider API keys or base URLs (DeepSeek or otherwise) added to `.env`/`.env.example`/`docker-compose.yaml` for the `open-webui` service — the user configures this themselves post-deploy, out of scope for this plan.
- No Ollama service or Ollama env vars for `open-webui` — `ENABLE_OLLAMA_API=false`.
- No `DATABASE_URL` set — SQLite (Open WebUI's own default) is used as-is.
- Every port binding follows the existing convention: `127.0.0.1:<host-port>:<container-port>` — never bind to `0.0.0.0` or omit the host IP.

---

### Task 1: Vendor cleanup + `open-webui` compose service

**Files:**
- Modify: `docker-compose.yaml`
- Modify: `.env.example`
- Delete: `open-webui/.git` (directory)

**Interfaces:**
- Produces: a new `open-webui` service reachable at `http://localhost:3001` after `docker compose up --build open-webui`.

- [ ] **Step 1: Flatten `open-webui/` into a plain vendored subdirectory**

`open-webui/` currently has its own `.git` directory (confirmed via `ls -la open-webui/.git` during planning — it's a real nested git repository, currently showing as an untracked directory `?? open-webui/` in this project's `git status`, not yet committed). This mirrors exactly how `genoffice/` was vendored earlier in this project's history (its own `.git` was removed so it became a plain subdirectory tracked by this repo, not a submodule or nested repo) — apply the identical treatment:

```bash
rm -rf open-webui/.git
```

- [ ] **Step 2: Run `git status` and confirm `open-webui/` now shows as regular untracked files**

Run: `git status --short open-webui | head -20`
Expected: many `??` lines for individual files/directories under `open-webui/` (not a single `?? open-webui/` line for the whole nested-repo gitlink) — confirms it's now a plain subdirectory.

- [ ] **Step 3: Add the `open-webui` service to `docker-compose.yaml`**

Add this new top-level service (alongside the existing `app`/`searxng`/`scrapling`/`made` services — insert it after `made`, matching the file's existing ordering of "this project's own services first, then vendored/external ones"):

```yaml
  open-webui:
    build: ./open-webui
    ports:
      - "127.0.0.1:3001:8080"
    environment:
      - WEBUI_SECRET_KEY=${WEBUI_SECRET_KEY}
      - ENABLE_OLLAMA_API=false
    volumes:
      - open-webui-data:/app/backend/data
```

Then add the named volume at the bottom of the file (create a top-level `volumes:` key if one doesn't already exist — check the current file first; as of planning, `docker-compose.yaml` has no `volumes:` section, so add one):

```yaml
volumes:
  open-webui-data:
```

The full resulting file (for reference — verify against the actual current file content before applying, in case it changed since planning):

```yaml
services:
  app:
    build: .
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      - searxng
      - scrapling
      - made

  searxng:
    image: searxng/searxng:latest
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
    ports:
      - "127.0.0.1:8080:8080"

  scrapling:
    image: python:3.12-slim
    command: sh -c "pip install --no-cache-dir 'scrapling[ai]==0.4.12' 'mcp<2.0' && python -m playwright install --with-deps chromium && scrapling mcp --http --host 0.0.0.0 --port 8000"
    ports:
      - "127.0.0.1:8000:8000"

  made:
    build: ./MADE
    ports:
      - "127.0.0.1:8001:8000"

  open-webui:
    build: ./open-webui
    ports:
      - "127.0.0.1:3001:8080"
    environment:
      - WEBUI_SECRET_KEY=${WEBUI_SECRET_KEY}
      - ENABLE_OLLAMA_API=false
    volumes:
      - open-webui-data:/app/backend/data

volumes:
  open-webui-data:
```

- [ ] **Step 4: Add `WEBUI_SECRET_KEY` to `.env.example`**

Add this block to `.env.example` (append at the end of the file, after the existing `DEEPSEEK_BASE_URL=...` line):

```
# Open WebUI's own session-signing secret (JWT) — NOT an LLM API key, has
# nothing to do with any model provider. It signs login-session tokens for
# Open WebUI's own auth system; if it changes, everyone gets logged out.
# Any random string works — generate one with `openssl rand -hex 32`.
WEBUI_SECRET_KEY=
```

Do NOT add `WEBUI_SECRET_KEY` to the real `.env` file yourself — the user fills in their own value there (`.env` is gitignored and not part of this repo's tracked state; `.env.example` is the template this task is responsible for).

- [ ] **Step 5: Verify `docker-compose.yaml` is valid**

Run: `docker compose config --quiet`
Expected: no output, exit code 0 (validates YAML syntax and variable references without starting anything).

- [ ] **Step 6: Build and start the new service**

The implementer must set `WEBUI_SECRET_KEY` in their own local `.env` first (it's a new required variable — generate one, e.g. `openssl rand -hex 32 >> .env` won't format it correctly; instead run `echo "WEBUI_SECRET_KEY=$(openssl rand -hex 32)" >> .env`), then:

```bash
docker compose up --build open-webui
```

Expected: the image builds successfully (multi-stage: Node build stage compiles the SvelteKit frontend, then the Python stage packages it — this step can take several minutes on first build), and the container reaches a healthy state (`docker compose ps` should show `open-webui` as `healthy` once its own `HEALTHCHECK` — `curl .../health` — passes; this can take up to ~30-60s after container start while the Python backend initializes).

- [ ] **Step 7: Verify the app is reachable and functional**

With the container running:
1. `curl -sf http://localhost:3001/health` — expected: a JSON response indicating healthy status (matches what the container's own `HEALTHCHECK` checks).
2. Open `http://localhost:3001` in a browser — expected: Open WebUI's sign-up screen loads (not an error page).
3. Create the first account — expected: lands in the app, Admin Settings should be accessible (confirms first-user-becomes-admin behavior).
4. Check logs for Ollama-related noise: `docker compose logs open-webui | grep -i ollama` — with `ENABLE_OLLAMA_API=false`, expected: no active probing/connection-attempt errors (informational startup log lines mentioning the setting being read are fine; repeated connection-refused errors are not).

- [ ] **Step 8: Verify persistence**

```bash
docker compose restart open-webui
```
Then reload `http://localhost:3001` in the browser and confirm the account created in Step 7 still exists and you're still able to log in (proves the `open-webui-data` volume mount is correctly persisting the SQLite database across container restarts).

- [ ] **Step 9: Commit**

```bash
git add open-webui/ docker-compose.yaml .env.example
git commit -m "feat: deploy Open WebUI as a new docker-compose service"
```

(This will be a large commit — vendoring `open-webui/`'s full source tree, similar in kind to how `genoffice/` was originally vendored. That's expected, not a mistake to fix.)

---

## Manual verification (recommended)

Already covered by Task 1's Steps 6-8 (build, reachability, first-login/admin, persistence-across-restart). No further manual verification beyond what the task itself already requires — there's no separate "later" check needed since this plan has only one task and it's fully infrastructure-scoped.
