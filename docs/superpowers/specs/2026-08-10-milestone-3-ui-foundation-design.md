# Design: Milestone 3 Sub-Project 1 — React + Univer UI Foundation

Status: approved by user (2026-08-10).
First sub-project of Milestone 3 (see `docs/superpowers/specs/2026-08-09-ai-workspace-design.md` §5). Milestone 3 was decomposed into independent sub-projects during brainstorming rather than built as one spec — this covers only the UI/framework foundation; the "create document from chat" tool and the AI sidebar inside Univer are separate, later sub-projects.

## 1. Goal

Replace the static HTML chat page with a real React frontend, and add a second page that mounts Univer with a locally-editable (not yet persisted, not yet AI-triggered) document — proving the UI foundation Milestone 3's later sub-projects will build on.

## 2. Critical constraint discovered during brainstorming: Univer's real-time collaboration is NOT free

Investigated during this brainstorm: Univer's core (editor rendering, single-user editing) is open-source and free. **Real-time multi-user collaboration (OT algorithm, conflict resolution, multi-user sync) is part of Univer Pro, released under the Univer Commercial License** — evaluable with limits (watermark, import size caps, collaboration quotas), but the vendor's own docs recommend a paid license for production use. This directly affects the original design spec's "self-hosted, free-tier" premise (§1) as it applies to collaboration specifically — the document *editor* stays free, but *real-time collaboration* does not.

Decision: this sub-project (and Milestone 3 generally, for now) targets **single-user editing only**. Real-time collaboration via Univer Pro is explicitly deferred — not decided against, just not committed to — until there's a concrete need and budget. Do not build architecture that assumes free real-time collaboration is coming; when/if it's evaluated, it may require a paid license.

## 3. Architecture

Add a `client/` directory at the repo root (sibling to `src/`, `tests/`, `public/`) containing a React + TypeScript frontend built with **Vite**, as **two separate entry points** — `chat.html` (replaces the current static `public/index.html`) and `document.html` (new, mounts Univer). No client-side router (e.g. react-router) — two static pages don't justify one; add a router only when a third page makes the lack of one actually costly.

`src/server.ts` (the existing native `node:http` backend, unchanged otherwise) is updated to serve the built output of `client/dist/` instead of `public/`, and to route `GET /document` (or `/document.html`) to the document page. The `/api/chat` endpoint and all backend logic (`src/chat.ts`, MCP tool loop, MADE integration) are completely unchanged by this sub-project — this is a presentation-layer-only change.

During development, Vite's own dev server runs separately from the backend (`npm run dev` continues to run the Node backend; a new script runs the Vite dev server), with Vite configured to proxy `/api/*` requests to the backend's port so hot-reload works without restarting the backend.

## 4. Components

- **`client/src/chat/`** — a React reimplementation of the existing chat UI (message input, send button, log of exchanges including the `[tools: ...]` summary line from the hardening rounds). Behavior is a like-for-like port, not a redesign — same functionality as `public/index.html` today, just in React.
- **`client/src/document/`** — mounts Univer's **Docs** module (word-processor-style editor, chosen first because the original design spec's example is "turn this report into a Word doc") via `@univerjs/presets`, rendering a blank document that can be typed into and edited manually in the browser. No save/persistence (Nextcloud integration is Milestone 4), no AI-triggered creation (that's the next Milestone 3 sub-project) — this proves the editor mounts and works, nothing more.
- `src/chat.ts`, `src/mcp/*`, `src/made-client.ts`, `src/candidates.ts`, `src/tools.ts` — **unchanged**. No backend logic is touched by this sub-project.

## 5. Build & Docker

`npm run build` runs both `tsc` (backend, unchanged) and `vite build` (client, new) in sequence. `Dockerfile` is updated to copy `client/` into the build context and run the client build alongside the existing backend build, so the final image serves `client/dist/` instead of `public/`. `docker-compose.yaml`'s `app` service is otherwise unaffected — same port, same env wiring from the hardening rounds.

## 6. Testing

Backend test coverage (`node:test`, `tests/`) is completely unaffected — no backend logic changed. No automated test suite is added for the new React components in this sub-project: the project has no React testing library set up yet, and the sub-project's entire scope is "does Univer mount, does chat still work" — adding a testing framework for that narrow a check is premature (YAGNI). Verified manually instead: open `/chat.html`, send a message, confirm the reply (including tool-usage summary) renders identically to the current static page's behavior; open `/document.html`, confirm the Univer Docs editor renders and accepts typed input.

## 7. Out of Scope

- Real-time collaboration (Univer Pro) — see §2, explicitly deferred, not decided against.
- AI-triggered document creation from chat (e.g. a `create_document` tool) — next Milestone 3 sub-project.
- AI sidebar inside Univer with `document_context` — later Milestone 3 sub-project, depends on the AI-triggered-creation sub-project existing first.
- Document persistence to Nextcloud — Milestone 4.
- Any change to backend chat/tool-calling logic.
- Univer Sheets/Slides modules — Docs only, for now; other modules are a later decision once Docs proves the integration pattern.
