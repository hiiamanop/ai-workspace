# Inline Web-Search Citations Design

## Goal

When the model answers using `web_search`, show ChatGPT-style inline
citation chips (e.g. a small favicon/source badge right after the cited
sentence) that open a source-card popover on click — in both the root
project's own chat (`localhost:3000/`, `client/src/chat/ChatApp.tsx`) and
GenOffice's document AI panel (`/document`,
`genoffice/apps/docs/src/renderer/ai/AiPanel.tsx`).

This absorbs a previously-agreed, not-yet-started fix: GenOffice's
`web_search` tool currently always executes through Electron's
`window.desktop.webSearch` IPC, which is stubbed to fail with
`"not available in the web build"` whenever GenOffice isn't running as a
packaged Electron app (`genoffice/apps/docs/src/renderer/desktop-stub.ts:4,48`).
Both problems need the same underlying change — structured, per-result
search data flowing from SearXNG through to the UI — so they ship together.

## Non-goals

- `image_search` stays as-is (still Electron-only, still unfixed). SearXNG's
  MCP tool has no image category wired up here; extending it is a separate
  follow-up if wanted.
- No citation guarantee: the model is instructed to cite with `[N]` markers,
  but nothing enforces it. A reply that doesn't cite still renders normally,
  just without chips. This is a UI enhancement, not a correctness contract.
- No persistence of citations/search history (consistent with the rest of
  the project — no DB layer exists yet).

## 1. Structured search results (`src/mcp/searxng-client.ts`)

`mcp-searxng`'s `searxng_web_search` tool accepts `response_format: "json"`
and returns full structured SearXNG results instead of a formatted text
blob (confirmed by reading `node_modules/mcp-searxng/dist/search.js` —
`performWebSearch()` returns `JSON.stringify({...data, results: slicedResults})`
when `response_format === "json"`, where each result has `title`, `content`,
`url`, `score`, and (engine-dependent, often absent) `publishedDate`).

`callWebSearch()` changes shape: it currently returns the raw MCP text
string. It will instead call the tool with `response_format: "json"`, parse
the JSON, and return:

```ts
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  answer?: string; // SearXNG "direct answer", when present
}

export async function callWebSearch(query: string, ...): Promise<WebSearchResponse>
```

Callers that need model-facing text (both root `chat.ts`/`agent-turn.ts`
tool executors, and the new `/api/web-search` HTTP endpoint for GenOffice)
format `WebSearchResponse` into the numbered, citable text described below.
A parse failure (malformed JSON, missing `results`) surfaces as a thrown
error — same as today's failure path, still caught by the existing
try/catch in `chat.ts`/`agent-turn.ts` and turned into a
`"web_search failed: ..."` tool-result string.

## 2. Numbered tool-result text + citation instruction

Both the root project and GenOffice already truncate/format tool output
before handing it back to the model. That formatting changes to a
numbered list, using a **running counter across all `web_search` calls in
the same turn** (not reset per call), so citation numbers stay unique
throughout one answer even if the model searches twice:

```
[1] Peraturan Bank Indonesia Nomor 23/6/PBI/2021 — 1 July 2021
    Di Indonesia, aktivitas yang masuk kategori Penyedia Jasa Pembayaran...
    https://www.bi.go.id/...

[2] ...
```

The `web_search` tool description (`src/tools.ts`'s `TOOL_DEFS.web_search`,
and GenOffice's equivalent in `apps/docs/src/renderer/ai/tools.ts`'s
`AGENT_TOOLS`) gains one added sentence: *"When you state a fact drawn from
a search result, cite it immediately after the sentence using the result's
number in brackets, e.g. `[1]` or `[1][2]` for multiple sources."* This is
the only prompting lever — no output-format enforcement, per Non-goals.

**Running counter placement:**
- `src/chat.ts` / `src/agent-turn.ts`: a `let citationOffset = 0` local to
  `handleChat`/`handleAgentTurn`, incremented by `results.length` each time
  a `web_search` call is formatted, passed into the formatter so numbering
  continues across tool-loop iterations.
- GenOffice `apps/docs/src/renderer/ai/tools.ts`: same counter, scoped to
  one `AgentLoop` turn (i.e. reset each time the user sends a new message,
  not each tool call) — lives alongside the existing `executeAsyncTool`
  call site, likely lifted into whatever per-turn state `docs-skill.ts`
  already threads through `executeTool`.

## 3. Root project: new `sources` stream event

The root project's WS protocol has no side-channel for UI-only data (unlike
GenOffice's `ToolDisplay`, see §5), so a new event type is added:

```ts
// emitted by server.ts right after a web_search tool call resolves successfully
{ type: "sources", turnId, seq, results: WebSearchResult[] /* full accumulated list so far this turn */ }
```

Wiring:
- `ChatStreamCallbacks` (`src/chat.ts`) and `AgentTurnStreamCallbacks`
  (`src/agent-turn.ts`) gain `onSources: (results: WebSearchResult[]) => void`,
  called right after a `web_search` executor resolves (not on `scrape` or
  other tools).
- `src/server.ts`'s `startTurn()` wires `onSources` to
  `emit(turnId, { type: "sources", results })`.
- Sent as the **full accumulated list so far**, not a delta — simplest for
  the client (no merge logic; each event fully replaces the client's
  citation list for the turn).

## 4. Root UI: `ChatApp.tsx` citation chips

- New client state: `sourcesRef = useRef<WebSearchResult[]>([])`, reset in
  the `turn_started` handler (same place `lastSeqRef` already resets),
  updated on `"sources"` messages.
- On `"done"`, the final assistant message gets a `sources` field alongside
  `content` (extending the local `ChatMessage` interface with
  `sources?: WebSearchResult[]`), snapshotting `sourcesRef.current`.
- Rendering: before calling `marked.parse()`, a regex pass
  (`/\[(\d+)\]/g`) rewrites each `[N]` into
  `<sup class="cite" data-cite="N"><span class="fav" style="background-image:url(...)"></span></sup>`
  using a favicon derived from the result's URL host
  (`https://www.google.com/s2/favicons?sz=32&domain=<host>` — no new
  dependency, same trick used for OSS "unfurl" widgets). Only markers with
  a matching index in `sources` are rewritten; out-of-range numbers are
  left as plain text (defensive — a model hallucinating `[7]` with 3 real
  sources shouldn't render a broken chip).
- `DOMPurify.sanitize()`'s allowlist needs `data-cite` and inline
  `style="background-image:..."` explicitly permitted (`ADD_ATTR`), or the
  chip markup is stripped as an XSS vector by default. The `background-image`
  URL is server/client-constructed from `new URL(source.url).hostname`, never
  from raw model output, so this doesn't reopen an injection path — the
  citation number is the only thing pulled from model text, and it only
  selects an index into a same-turn, already-fetched array.
- Click handling via event delegation: one `onClick` on the message
  container div, `event.target.closest('[data-cite]')` reads the `data-cite`
  attribute, opens a popover component anchored to that chip
  (`getBoundingClientRect()`), showing the source card(s) — grouped when
  multiple adjacent `[N][M]` markers point at different sources close
  together, matching the reference screenshot's "+1" badge and left/right
  arrow carousel (index/total counter, no external carousel library —
  a handful of lines of state: `openIndex`, `openSources: WebSearchResult[]`).
- Popover shows: source hostname (as the "site name" — no separate favicon
  metadata is fetched), title, `publishedDate` if present (often absent per
  live testing against this project's SearXNG instance — omit the row
  entirely rather than showing "unknown date").

## 5. GenOffice fix: `desktop-stub.ts` → real search

New root-project HTTP endpoint, `POST /api/web-search` (`src/server.ts`),
same-origin with `/document` (confirmed: `document.html` is built by this
project's own Vite config and served from `CLIENT_DIST_DIR` — no CORS
needed):

```
POST /api/web-search  { query: string, maxResults?: number }
→ 200 { results: WebSearchResult[], answer?: string }
→ 500 { error: string }
```

Thin wrapper around `callWebSearch()`, mirroring the existing
`/api/chat`/`/api/agent-turn` handlers' request/response/error shape.

`genoffice/apps/docs/src/renderer/desktop-stub.ts`'s `webSearch` changes
from the canned `NOT_AVAILABLE` stub to:

```ts
webSearch: async (query, maxResults) => {
  try {
    const res = await fetch("/api/web-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, maxResults }),
    });
    if (!res.ok) return { results: [], method: "error", error: (await res.json()).error };
    const data = await res.json();
    return { results: data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })), answer: data.answer, method: "searxng" };
  } catch (err) {
    return { results: [], method: "error", error: (err as Error).message };
  }
},
```

matching the `DesktopApi.webSearch` return shape already defined in
`apps/docs/src/shared/ipc.ts:214-223`. No changes needed to
`executeAsyncTool` in `tools.ts` — it already consumes `r.results`/`r.answer`
in this exact shape (`tools.ts:296-313`); it just starts getting real data
instead of the stub error. This is deliberately the *only* change on
GenOffice's Electron-vs-web-build boundary — `docs-main.ts`'s real Electron
IPC path (used when packaged) is untouched and keeps using
`@genoffice/ai-search` (Serper/GSK/DuckDuckGo) as before.

## 6. GenOffice UI: citation chips in `AiPanel.tsx`

GenOffice has an existing, unused-by-docs side channel for exactly this —
`ToolDisplay` (`packages/agent-core/src/types.ts:44-50`,
`{ kind: 'images'|'links'|'text', items?: Array<{url,title,thumb?}> }`) —
already rendered as a block widget in the **slides** app's AiPanel
(`apps/slides/src/renderer/ai/AiPanel.tsx:2157-2189`) but never wired into
the **docs** app. Reusing it avoids inventing a second protocol:

- `apps/docs/src/renderer/ai/tools.ts`'s `web_search` case in
  `executeAsyncTool` (currently `tools.ts:293-314`) adds
  `display: { kind: 'links', items: r.results.map(it => ({ url: it.url, title: it.title })) }`
  to its returned `ToolExecution`. (`thumb` is left unset — the docs AiPanel
  derives the favicon client-side the same way `ChatApp.tsx` does, keeping
  the derivation logic in one place conceptually even though it's
  duplicated across the two codebases.)
- `ChatEntry` (`AiPanel.tsx:66-78`) gains `citations?: WebSearchResult[]`
  (mirrors §4's client-side `sources` field), populated from
  `ToolActivity`/`display.items` when a `web_search` tool activity resolves
  during that turn — accumulated the same way `tools: ToolActivity[]`
  already accumulates per entry.
- The `<Markdown text={entry.text} />` call sites (`AiPanel.tsx:875, 939`)
  get the same `[N]` → chip treatment as §4, factored into a shared
  helper if practical (both are React/TSX + `marked`/DOMPurify-based —
  check during planning whether the docs app's `Markdown` component already
  wraps the same libraries as `ChatApp.tsx` before deciding whether to share
  code or duplicate the ~30 lines).

## Error handling

- SearXNG/MCP failure: unchanged behavior — `callWebSearch` throwing
  produces the existing explicit `"web_search failed: ..."` tool-result
  text (never silently empty), per the pre-existing "backend failure must
  not read as no results" design already in both `chat.ts`/`agent-turn.ts`
  and GenOffice's `tools.ts:297`.
- Malformed/missing JSON from `mcp-searxng` (`response_format: "json"`
  parse failure): treated as a thrown error, same path as above.
- Citation marker with no matching source (model hallucinated `[7]` with
  only 3 results, or referenced a search from *before* a context-trim
  dropped it): rendered as plain text, not a broken chip.
- GenOffice's `/api/web-search` unreachable (server down): `desktop-stub.ts`
  catches the fetch error and returns `{results:[], method:"error", error}`,
  same shape `tools.ts:298-303` already branches on — the existing
  "web search failed (service error, not an empty result — you may retry)"
  message still fires, now for a real transient-network reason instead of
  always.

## Testing

- `src/mcp/searxng-client.ts`: unit tests for `callWebSearch()` against a
  fake MCP client returning both well-formed and malformed JSON.
- `src/chat.ts` / `src/agent-turn.ts`: extend existing tool-loop tests to
  assert `onSources` fires with the right accumulated (not reset) list
  across two `web_search` calls in one turn.
- `src/server.ts`: WS test asserting a `sources` event is emitted with
  `turnId`/`seq` alongside existing `delta`/`tool_result` coverage.
- New `POST /api/web-search` endpoint: HTTP test mirroring the existing
  `/api/chat` request/response/error tests.
- `ChatApp.tsx` / GenOffice `AiPanel.tsx`: no automated tests, per this
  project's established pattern (client UI is manually verified) —
  flagged explicitly at plan-completion time, same as the streaming-chat
  work.

## Out of reach

- `image_search` citations / fixing GenOffice's image search Electron
  dependency.
- Enforcing that the model always cites (prompt-only, best-effort).
- Persisting search/citation history anywhere.
- Deduplicating citations when the same URL appears from two different
  `web_search` calls in one turn (each call's results get fresh numbers,
  even if a URL repeats — acceptable given SearXNG's own de-duplication
  already limits how often this happens within one query).
