# Design: Streaming, resumable, history-aware LLM chat

Status: approved by user (2026-08-11).

Second of three originally-planned sub-projects toward an optimal, token-efficient, UX-friendly LLM chat, merged at the user's explicit request with the third (conversation-history/token-budget) rather than sequenced separately. Builds on [[context-guard]] (`docs/superpowers/plans/2026-08-11-context-guard.md`, merged) and the original MADE context-capacity work (`docs/superpowers/plans/2026-08-11-made-context-capacity.md`, merged) — neither is modified here beyond the signature changes needed to thread streaming callbacks through.

Covers both chat surfaces in ai-workspace: `/api/chat` (`src/chat.ts`, the standalone chat page at `client/src/chat/ChatApp.tsx`) and GenOffice's AI panel (`src/agent-turn.ts`, consumed via `genoffice/apps/docs/src/renderer/ai/transport.ts`'s `createMadeTransport()`).

## 1. Background

The original GenOffice AI-panel design explicitly deferred real token streaming ("per-langkah saja dulu"). Revisiting that decision: GenOffice's own `AgentStreamCallbacks` contract (`onDelta`, `onToolCall`, `onDone`, `onError`) already supports true incremental streaming — it's used today by GenOffice's original `electron-transport.ts`. `createMadeTransport()` (our replacement transport) currently calls `onDelta()` exactly once with the full response text, after a single non-streaming `fetch()`+JSON round trip. `/api/chat`'s client (`ChatApp.tsx`) has the same one-shot pattern. Neither provider client (`ollama-client.ts`, `deepseek-client.ts`) requests `stream: true`, despite both being OpenAI-compatible endpoints that support it.

Separately, `/api/chat` (`handleChat()`) is fully stateless today — it takes a single `message: string` and has no conversation history at all, unlike `agent-turn.ts` which already receives a client-supplied `messages` array each turn. This spec brings `/api/chat` up to the same history-carrying shape and adds token-budget-aware trimming, consistent with the mechanical (non-LLM) elision approach already established in GenOffice's `buildDocumentContext()` and the pending `elideMiddle()` selection-trim spec.

## 2. Architecture

A single new WebSocket endpoint, layered onto the existing `http.createServer()` in `src/server.ts` via the `upgrade` event (using the `ws` package — no other infrastructure change). One persistent connection is opened per page load (chat page or GenOffice document page) and reused for every turn in that session; the existing `/api/chat` and `/api/agent-turn` HTTP routes are kept unchanged as a non-streaming fallback.

One WS endpoint serves two message "kinds" via a `type` discriminator:
- `{ type: "chat", messages: ChatMessage[] }` → `handleChat()`, used by the chat page.
- `{ type: "agent-turn", system, messages, tools }` → `handleAgentTurn()`, used by GenOffice's AI panel.

Server → client event types (all carry a `turnId` and monotonic `seq`):
- `{ type: "delta", turnId, seq, text }` — a content token chunk.
- `{ type: "tool_call_delta", turnId, seq, index, id?, name?, argsFragment }` — a tool-call construction chunk.
- `{ type: "tool_result", turnId, seq, index, name, result }` — a server-executed tool (web_search/scrape) has finished.
- `{ type: "done", turnId, seq, ...finalMetadata, stopped?: boolean }` — turn finished (`finalMetadata` is `{selectedCandidateId, toolsUsed}` for chat, or `{tool_calls}` for agent-turn's client-tool handback, matching each handler's existing return shape).
- `{ type: "error", turnId, seq, error }`.

Client → server control messages:
- `{ type: "resume", turnId, lastSeq }` — reattach to an in-flight turn after reconnect.
- `{ type: "stop", turnId }` — cancel an in-flight turn.

**Streaming covers the entire turn, not just the final answer** (reopened from the original per-step-only decision): every loop iteration in `chat.ts`/`agent-turn.ts` streams live, including tool-calling steps, not just the final non-tool-calling completion.

## 3. Provider streaming

`src/providers/ollama-client.ts` and `src/providers/deepseek-client.ts` each gain a new exported function, `completeStream()`, alongside the existing `complete()` (kept as-is, still used by tests and as the non-WS HTTP fallback path):

```typescript
export async function completeStream(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  callbacks: {
    onDelta: (text: string) => void;
    onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) => void;
  },
  signal?: AbortSignal,
  /* existing baseUrl/apiKey/fetchImpl params unchanged, appended after */
): Promise<CompletionResult>
```

It sends `stream: true` in the request body, reads the response as SSE (`data: {...}\n\n` lines, terminated by `data: [DONE]`), and for each parsed chunk:
- If the chunk's `delta.content` is present, call `onDelta(text)` immediately.
- If the chunk's `delta.tool_calls` is present, call `onToolCallDelta(...)` immediately for the arriving fragment, AND accumulate the fragment internally (concatenating `argsFragment` by `index`) to reconstruct the final `toolCalls` array.

This assumes a single response is either all-content or all-tool-calls, never a mix mid-stream — true for every OpenAI-compatible API observed in this codebase's providers, though not a documented spec guarantee; noted as an accepted constraint, not re-verified per-provider. `signal`, when provided and aborted, causes the underlying `fetch()` to throw `AbortError`, which the caller (the chat-turn loop) treats as a clean stop, not an error.

The function still resolves to the same `CompletionResult` (`{content, toolCalls}`) as `complete()` once the stream ends, so `chat.ts`/`agent-turn.ts`'s post-completion logic (tool execution, loop continuation) is unchanged in shape — only its inputs (streamed vs buffered) differ.

## 4. Wiring into `chat.ts` and `agent-turn.ts`

Both `handleChat()` and `handleAgentTurn()` gain an optional `streamCallbacks` parameter (undefined when called via the existing non-streaming HTTP routes, preserving current behavior exactly):

```typescript
interface TurnStreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) => void;
  onToolResult: (index: number, name: string, result: string) => void;
  signal?: AbortSignal;
}
```

When present, every loop iteration calls `completeStream()` (instead of `complete()`) with `streamCallbacks.onDelta`/`onToolCallDelta` wired straight through, and calls `streamCallbacks.onToolResult(index, name, result)` right after executing each server-side tool (`web_search`/`scrape`), before looping to the next iteration. The existing `context-guard` capacity check (`ensureCandidateFits()`, from the just-merged plan) runs exactly as it does today, before each iteration, unaffected by streaming — the estimate calculation and switch/exhausted handling are unchanged; only the completion call itself becomes streaming.

`handleChat()`'s signature also changes from `handleChat(message: string, ...)` to `handleChat(messages: ChatMessage[], ...)`, matching `handleAgentTurn()`'s existing shape (see §6, Conversation history).

## 5. Server: WebSocket layer, turn lifecycle, resume, stop

`src/server.ts` attaches a `WebSocketServer` (from the `ws` package) to the existing `http.Server` via its `upgrade` event, on the same port. Each accepted connection becomes a session; the server maintains:

- `Map<turnId, { buffer: {seq, message}[]; controller: AbortController; status: "running" | "done" | "error" }>` — one entry per in-flight or recently-finished turn, independent of any particular socket.
- On `{type:"chat"|"agent-turn"}`: generate `turnId = crypto.randomUUID()`, create an `AbortController`, register the map entry, call `handleChat()`/`handleAgentTurn()` with `streamCallbacks` that both (a) send the event on the currently-attached socket if any, and (b) append it to `buffer` with the next `seq`. Entries are capped at 500 buffered events per turn and evicted 60 seconds after reaching `"done"`/`"error"` status.
- On `{type:"resume", turnId, lastSeq}`: look up the entry; if found, replay buffered events with `seq > lastSeq` to the (newly reattached) socket synchronously, then continue relaying live events as they occur. If not found, send `{type:"error", error:"turn not found, please retry"}`.
- On `{type:"stop", turnId}`: look up the entry and call `.controller.abort()`; the in-flight `fetch()` inside `completeStream()` throws `AbortError`, the turn loop catches this specifically and sends `{type:"done", turnId, seq, stopped:true, ...whatever partial metadata is available}` instead of propagating an error.
- On socket close: no cleanup of the turn itself — it keeps running and buffering, unaffected by the specific socket's lifecycle. Only the map entry's own 60-second post-completion eviction timer removes it.

The existing HTTP `/api/chat`/`/api/agent-turn` routes are unchanged and continue to call `handleChat()`/`handleAgentTurn()` without `streamCallbacks`.

## 6. Conversation history and token budget

`client/src/chat/ChatApp.tsx` gains a `messages: ChatMessage[]` state (role/content pairs) instead of the current display-only `log: string[]`. Each submit appends `{role:"user", content}` to this array and sends the **entire** array (not just the new message) as `{type:"chat", messages}`; the assistant's streamed reply is appended as `{role:"assistant", content}` once its turn completes.

`handleChat()`'s new `messages: ChatMessage[]` parameter is trimmed before being sent to the model by a new pure function, `src/history-budget.ts`'s `trimHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[]`: using the existing `estimateContextTokens()`, if the full history's estimate exceeds `budgetTokens`, drop the oldest messages one at a time (never partial-message truncation, whole messages only) until the remainder fits. This is mechanical, not LLM-based summarization — consistent with GenOffice's existing `buildDocumentContext()` block-elision and the pending selection-trim spec's `elideMiddle()`, both of which deliberately chose mechanical truncation over LLM summarization for the same reason (extra request, cost, latency). `HISTORY_BUDGET_TOKENS` is a new constant (`6000`), chosen conservatively below the smallest realistic model window (Ollama's default `4096` plus headroom) so trimming engages well before a hard context-capacity failure — it does not replace `context-guard`'s mid-loop capacity check, which still runs as the actual safety net.

`handleAgentTurn()` is unaffected here — GenOffice already sends and manages its own client-side history; this section only closes the gap that was specific to `/api/chat`.

No database, no cross-page-reload or cross-device persistence: history lives in `ChatApp.tsx`'s in-memory React state (cleared on reload) and, mid-turn, in the server's per-turn buffer from §5 (evicted after completion). Durable persistence needs a database this project does not yet have — a separate, larger architectural decision already identified this session as a Milestone 4/Nextcloud candidate, out of reach of this spec without first choosing that whole stack.

## 7. UX additions

- **Stop generating:** the chat page's "Send" button becomes "Stop" while a turn's `turnId` is active; clicking it sends `{type:"stop", turnId}`. GenOffice's AI panel gets the same behavior wired through `createMadeTransport()`'s existing `cancel()` contract (already part of `AgentTransport` — it now sends the WS `stop` message instead of just locally suppressing further callbacks).
- **Typing indicator:** purely client-side state — `awaitingFirstToken` flips true when a turn starts, false on the first `delta`/`tool_call_delta`/`tool_result` event for that `turnId`. No new protocol.
- **Safe incremental markdown rendering:** two new dependencies, `marked` (parser) and `dompurify` (sanitizer) — on every `delta` event, the accumulated text-so-far for that message is re-parsed in full (cheap at chat-message sizes; not diffed/patched incrementally) via `marked.parse()`, then sanitized via `DOMPurify.sanitize()` before being rendered as HTML. Applies to both `ChatApp.tsx` and GenOffice's AI panel message rendering.
- **Regenerate:** a button on the last assistant message in `ChatApp.tsx`; sends `{type:"chat", messages}` again with `messages` truncated to exclude that last assistant reply (and its preceding turn's tool messages, if any), as a new turn. The new response replaces the old one in the displayed `messages` array once complete. No new server-side logic — purely a client-side resend with a shorter array.

## 8. Error handling

- Provider/decide failure mid-turn (not a user-initiated stop): server sends `{type:"error", turnId, seq, error}`; the WS connection itself stays open for the next turn.
- Unexpected socket close (network drop): the in-flight turn keeps running server-side (§5). Client attempts reconnect with exponential backoff (500ms, 1s, 2s, 4s, 8s; 5 attempts, then a manual "reconnect" button is shown). On successful reconnect, if a turn was in flight, the client sends `{type:"resume", turnId, lastSeq}` instead of resubmitting.
- `context-guard`'s existing `"exhausted"` behavior (partial answer with the `[context window exhausted — response may be incomplete]` marker, or the `"MADE returned no eligible candidate"` throw) is unchanged; the throw path now results in the loop's error being sent as `{type:"error", ...}` over WS instead of an HTTP 500, when reached via the WS path.

## 9. Testing

- **`tests/providers/ollama-client.test.ts` / `deepseek-client.test.ts`**: new tests for `completeStream()` — mock an SSE response body (`data: {...}\n\n` lines), assert `onDelta` fires per content chunk, assert `onToolCallDelta` fires per tool-call chunk and the final resolved `toolCalls` is correctly reconstructed from fragments, assert an aborted `signal` causes the returned promise to reject with `AbortError` without calling `onDelta` further.
- **`tests/chat.test.ts` / `tests/agent-turn.test.ts`**: new tests asserting `streamCallbacks` (when provided) receive delta/tool-call-delta/tool-result events for every loop iteration including tool-calling ones, and that omitting `streamCallbacks` preserves all existing non-streaming test behavior unchanged.
- **`tests/history-budget.test.ts`** (new): unit tests for `trimHistory()` — under-budget history returned unchanged, over-budget history drops oldest whole messages until it fits, single-message-already-over-budget history is returned as-is (never partially truncated).
- **`tests/server.test.ts`**: new WS-level tests (using the `ws` package's client in tests) — connect, send `chat`, assert `delta`→`done` sequence; disconnect mid-turn and reconnect with `resume`, assert buffered events replay correctly; send `stop`, assert `{stopped:true}` in the resulting `done` event.
- **Client-side** (`ChatApp.tsx`, GenOffice `transport.ts`, markdown rendering, stop/regenerate buttons): verified manually via `npm run dev`, consistent with how UI work has been verified elsewhere in this project — no automated browser tests introduced.

## 10. Out of reach (not "out of scope" by choice — genuinely separate initiatives)

- Durable, cross-reload/cross-device conversation persistence — requires a database this project doesn't have; flagged as a Milestone 4/Nextcloud candidate.
- Authentication/authorization on the WS connection, and server-side rate limiting/abuse prevention — the project has no auth system at all today; both are infrastructure-level decisions independent of chat streaming itself.
- Multi-conversation management (switching between saved chat threads) — depends on the persistence layer above.
