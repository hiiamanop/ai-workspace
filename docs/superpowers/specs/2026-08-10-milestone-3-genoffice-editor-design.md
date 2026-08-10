# Design: Milestone 3 Sub-Project 2 — Replace Univer with GenOffice, connect its AI panel to MADE

Status: approved by user (2026-08-10).
Second sub-project of Milestone 3, replacing the first sub-project's Univer-based `/document` page (see `docs/superpowers/specs/2026-08-10-milestone-3-ui-foundation-design.md`). A "proper" visual design pass across the whole app is deliberately deferred to a third sub-project, sequenced after this one.

## 1. Background and goal

The first UI Foundation sub-project mounted Univer's free-tier Docs editor at `/document`. In production verification, the editor's `createUniverDoc()` call threw at runtime (`Cannot read properties of undefined (reading 'getDataModel')`) — traced to a version mismatch between the plan's reference example (an insiders build) and the pinned stable release, which requires a fully-formed `IDocumentData` snapshot rather than a title-only object. A follow-up fix corrected this, but during evaluation the user separately cloned `genoffice` (an Apache-2.0, AI-native, Electron-based office suite by Mainfunc, Inc., now checked out at `ai-workspace/genoffice/`) and decided to replace Univer with it entirely, rather than continue investing in Univer.

GenOffice's `apps/docs` is a mature, Tiptap-based (ProseMirror) Word-grade editor — footnotes, comments, revisions, tables, equations, an AI sidebar with document-editing tools — built as an Electron app (`src/main`, `src/preload`, `src/renderer`). Its AI sidebar already talks to a model through a generic `AgentTransport` interface (`packages/agent-core`), decoupled from any specific provider, and its multi-turn tool-calling loop (`agent-core`'s `loop.ts`) already runs entirely client-side. This sub-project replaces Univer with GenOffice's renderer, and implements a new `AgentTransport` that routes through MADE instead of GenOffice's own AI provider.

## 2. Scope decisions (explicit, from brainstorming)

- **Edited in place, not ported.** `genoffice/` stays where it was cloned (`ai-workspace/genoffice/`) and is modified directly — not copied piecemeal into `client/`. This includes vendoring `apps/docs` and its workspace package dependencies (`@genoffice/docx-engine`, `@genoffice/agent-core`, `@genoffice/ui`, `@genoffice/i18n`, and their transitives) as-is, even though file-open/save is not wired up yet.
- **App.tsx ported whole, Electron stubbed out.** `apps/docs/src/renderer/App.tsx` (~3265 lines: toolbar, menus, file actions, review actions) is used unmodified. `window.desktop` (the Electron preload bridge, `DesktopApi`) is replaced with a stub object satisfying the same type — calls resolve safely (no crash) but file open/save, recent files, and OS theme/language integration stay non-functional. Toolbar buttons for those features remain visible but inert. GenOffice's own `main.tsx` already tolerates a missing `window.desktop` in places (defensive `.catch()` and optional chaining) — the stub only needs to cover the call sites that don't already guard themselves.
- **No real .docx file I/O in this pass.** Opening/saving actual `.docx` files (and the alignment-on-open bug discovered in the real GenOffice desktop app, traced to `packages/docx-engine/src/parse.ts`'s `extractParaFormat()` not falling back to style-level `w:jc` when a paragraph has no direct alignment override) is out of scope here — the editor opens with a new, blank document, same as the Univer sub-project's scope. Revisit both together in the file-I/O sub-project.
- **AI panel is connected to MADE with a full tool-calling loop, not read-only Q&A.** The AI sidebar can both answer questions about the document and edit it directly, using GenOffice's existing 5 document-editing tools (insert/replace/format, etc., from `docs-skill.ts`).
- **`web_search` and `scrape` are available from the document AI panel too**, alongside the 5 document tools — merged in server-side (see §4), without modifying GenOffice's own skill/tool files.
- **No real token-level streaming.** Each model turn is delivered as one complete step (full text, or a batch of tool calls), not streamed character-by-character. This keeps the backend a single request/response endpoint instead of requiring end-to-end SSE.
- **No new automated tests for the vendored GenOffice/editor code**, consistent with the precedent set in the Univer sub-project — verified manually. The new backend endpoint (`/api/agent-turn`) does get automated tests, matching how `/api/chat` is tested today.

## 3. Architecture

`genoffice/apps/docs/src/renderer/index.html` becomes the source for a third Vite entry point (alongside `chat.html` and `document.html`'s replacement) in the root `vite.config.ts`. Because `genoffice/` has its own `node_modules` (installed via its own `npm install`, with its own `workspaces` covering `packages/*`), Vite's standard Node module resolution finds React, Tiptap, and all `@genoffice/*` packages from there automatically — no `file:` dependency links or duplicate installs are needed in `ai-workspace`'s root `package.json`. `vite.config.ts` gains `server.fs.allow` covering `genoffice/apps/docs/src/renderer` so the dev server may serve files outside the default project root.

`src/server.ts` serves the built output the same way it serves `chat.html` today, and gains one new route: `POST /api/agent-turn`. This endpoint is the MADE-connected backend for GenOffice's AI sidebar — see §4.

Univer is fully removed: `@univerjs/presets` and `@univerjs/preset-docs-core` come out of `package.json`, and `client/src/document/` (the Task 2 `DocumentApp.tsx`/`main.tsx` from the prior sub-project) and `client/document.html` are deleted.

## 4. AI panel ↔ MADE integration

GenOffice's AI sidebar (`AiPanel.tsx`) is driven by `agent-core`'s `loop.ts`, which already orchestrates the full multi-turn tool-calling conversation client-side: call the transport for one model turn, execute any requested tools via the active `AgentSkill` (`docs-skill.ts`, exposing 5 document-editing tools bound to the live Tiptap editor), append results, call the transport again, repeat until the model returns final text. This sub-project does not touch that orchestration — it only supplies a new `AgentTransport` implementation.

**New client-side file:** `apps/docs/src/renderer/ai/transport.ts` gains `createMadeTransport()` alongside the existing `createElectronTransport()`. `App.tsx` is changed to use it. Each time `loop.ts` needs one model turn, this transport `POST`s `{ system, messages, tools }` (the exact shape `docs-skill.ts` already builds) to `/api/agent-turn`, awaits one JSON response, and translates it into the `AgentStreamCallbacks` the loop expects (`onDelta` + `onDone` for text, `onToolCall` per call + `onDone` for tool calls, `onError` on failure).

**New backend file:** `src/agent-turn.ts`, structured like the existing `src/chat.ts` tool loop but with one key difference in exit condition. On each request:
1. Ask MADE (via the existing `made-client.ts`) to select a model, honoring `requires_human_approval` exactly as `/api/chat` does today.
2. Merge the server's own known tool defs (`web_search`, `scrape`, from the existing `TOOL_DEFS` in `src/tools.ts`) into the `tools` array the client sent (which already contains the 5 document tools) before calling the model. The model sees all 7 tools regardless of which page's AI feature is calling it.
3. Call the selected model once with `{ system, messages, tools }`.
4. If the model's turn requests a tool whose name is `web_search` or `scrape`, execute it immediately using the existing MCP clients (`src/mcp/*`), append the tool result to `messages`, and loop back to step 3 internally (capped at the same iteration limit `src/chat.ts` already uses) — **this never reaches the client**.
5. If the model's turn requests any other tool (i.e., one of the 5 document tools, which this server cannot execute), stop the internal loop and return `{ type: "tool_calls", calls: [...] }` — unexecuted — for the browser to run against the live editor.
6. If the model returns final text with no tool calls, return `{ type: "text", text }`.

This keeps all `web_search`/`scrape` execution logic in one place (`src/mcp/*`, reused, not duplicated into GenOffice's client-side skill code), and keeps GenOffice's own `docs-skill.ts`/`tools.ts` completely unmodified — the merge happens entirely on the backend.

**Route:** `POST /api/agent-turn` added to `src/server.ts`, parsing the request body and delegating to `src/agent-turn.ts`.

## 5. Error handling

- MADE unreachable, or its decision carries `requires_human_approval`: `/api/agent-turn` responds the same way `/api/chat` already does for these cases (matching status codes and error shape).
- `web_search`/`scrape` failing mid-loop: recorded as an `isError` tool result and fed back to the model, same behavior as the existing `/api/chat` loop — the model gets a chance to recover or explain the failure, the loop doesn't abort outright.
- Document-tool execution failures (e.g. a malformed insert/replace request): handled entirely client-side by GenOffice's existing, unmodified `docs-skill.ts`/`tools.ts` — outside this sub-project's changes.
- Transport-level failures (network error calling `/api/agent-turn`, non-2xx response): `createMadeTransport()` calls `onError`, which `loop.ts` already surfaces to the AI panel's UI.

## 6. Testing

- `src/agent-turn.ts` gets `node:test` coverage mirroring the existing `chat.ts` tests (mocked MADE + model client): a plain-text turn, a turn that hands back an unexecuted document-tool call, a turn where `web_search`/`scrape` is called and resolved internally without reaching the response, and the iteration cap being enforced.
- No automated tests for the vendored GenOffice renderer/editor code or the new `createMadeTransport()` — verified manually: open `/document`, confirm the editor renders and accepts input (as the Univer sub-project's manual check did), then use the AI panel to ask it to search the web and edit the document based on the result, confirming both tool types work in the same conversation.
- Existing `node:test` backend suite (`/api/chat` and everything from Milestones 1-2) must stay green throughout — this sub-project adds a new route and a new server-side module but does not modify `src/chat.ts` or the MCP clients.

## 7. Out of scope

- Real token-level streaming (SSE) end-to-end — deferred; per-turn JSON responses are used instead.
- Opening/saving real `.docx` files, and the alignment-on-open bug in `packages/docx-engine/src/parse.ts` (`extractParaFormat()` not resolving style-level `w:jc`) — both deferred together to a future file-I/O sub-project, since the bug is only reachable once file-open exists.
- A proper visual design pass across `ai-workspace` (chat page polish, shared look between chat and document pages) — explicitly deferred to a third Milestone 3 sub-project, sequenced after this one.
- Any change to `src/chat.ts`, the MCP clients' internal behavior, or the `/api/chat` endpoint's existing behavior.
- Univer Sheets/Slides, or any other GenOffice app (`sheets`, `slides`, `pdf`, `markdown`) beyond `docs`.
