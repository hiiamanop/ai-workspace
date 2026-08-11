# Design: Mid-loop context-capacity re-check ("context-guard")

Status: approved by user (2026-08-11).

First of three sub-projects under a broader "optimal LLM chat" goal (token-efficient, UX-friendly). Order agreed with the user: **context-guard (this spec) → streaming → conversation-history/token-budget management.** Each is its own spec/plan/implementation cycle; this one does not implement the other two.

## 1. Background

`docs/superpowers/plans/2026-08-11-made-context-capacity.md` (merged) added a MADE hard constraint that excludes a model candidate whose context window is smaller than a request's *estimated* token need, computed once via `estimateContextTokens()` at the single `decide()` call each of `src/chat.ts`'s `handleChat()` and `src/agent-turn.ts`'s `handleAgentTurn()` makes before entering their internal tool-calling loops.

The gap found by that plan's final review: both loops can run up to 5 iterations, each appending a tool result of up to `MAX_TOOL_RESULT_CHARS = 8000` chars (≈2000 tokens) to the running message history, without ever re-checking whether the now-larger conversation still fits the model MADE originally selected. A conversation that passed the gate at 3k tokens can reach ~13k tokens by iteration 5 — past the same context-window exhaustion the original MADE fix exists to prevent, silently reproducing the "AI returned no content" failure from inside the loop itself.

## 2. Architecture

A new shared helper, `src/context-guard.ts`, exporting one function used by both `chat.ts` and `agent-turn.ts`:

```typescript
export type CapacityCheckResult =
  | { status: "ok" }
  | { status: "switched"; candidate: CandidateIn }
  | { status: "exhausted" };

export async function ensureCandidateFits(
  current: CandidateIn,
  candidates: CandidateIn[],
  estimatedTokens: number,
  decide: (request: DecideRequest) => Promise<DecideResponse>
): Promise<CapacityCheckResult>
```

Logic: if `current.context_window_tokens` is unset, or `estimatedTokens <= current.context_window_tokens`, return `{ status: "ok" }` with no MADE call — this is the common case on nearly every loop iteration, so the check adds no latency in the normal path. Only when the estimate would exceed the current candidate's window does it call `decide()` again with the fresh estimate as `task.estimated_context_tokens`:
- MADE returns a candidate and doesn't require human approval → `{ status: "switched", candidate }`.
- MADE returns no candidate, or requires human approval → `{ status: "exhausted" }`.

This is a shared module (not duplicated per-file, unlike the intentionally-duplicated `truncateToolResult`) because the logic has multiple branches and both call sites need it to behave identically — the earlier duplication precedent was for a 5-line helper under an explicit "don't touch chat.ts" constraint that no longer applies.

## 3. Integration into `chat.ts` and `agent-turn.ts`

In both `handleChat()`'s and `handleAgentTurn()`'s tool-calling loop, immediately before each `complete()` call (including the first iteration — no special-casing, since the check is cheap when nothing needs to change):

1. Compute the current estimate from the live running message state (`estimateContextTokens(...)` over whatever `messages`/`tools` variables the loop already has in scope — the exact same shapes each file already uses for its initial `decideRequest()` call).
2. Call `ensureCandidateFits(selected, candidates, estimate, deps.decide)`.
3. `"switched"`: reassign `selected` to the new candidate, re-resolve `complete` from `deps.completeByProvider[selected.vendor]` (throwing `` `no provider client registered for vendor ${vendor}` `` if missing, same as the existing initial-selection check), and continue the loop with the new provider.
4. `"exhausted"`: return the best partial answer gathered so far, with an incomplete-response marker — same pattern `chat.ts` already uses for its `MAX_TOOL_ITERATIONS`-exceeded case (`` `${lastNonEmptyContent}\n\n[context window exhausted — response may be incomplete]` ``). If there is no partial answer yet (nothing non-empty has been produced), throw `"MADE returned no eligible candidate"` — the same message the initial top-level check already throws, kept identical for consistency rather than inventing new copy.

`chat.ts` already tracks `lastNonEmptyContent`; this is reused as-is. `agent-turn.ts` currently has no equivalent — it must gain the same tracking (a `lastNonEmptyText` variable updated whenever a completion returns non-empty `content`) so its `"exhausted"` case has the same partial-answer path available. Its `"exhausted"`-with-partial-answer branch returns `{ type: "text", text: `${lastNonEmptyText}\n\n[context window exhausted — response may be incomplete]` }`.

Both `selected` and `complete` change from `const` to `let` in both files to allow reassignment on `"switched"`.

## 4. Error handling

If the `decide()` call inside `ensureCandidateFits()` itself throws (e.g. MADE unreachable), the error propagates unchanged — no special handling, consistent with how the existing top-level `decide()` calls in both files already behave (caught generically by `server.ts`'s route handler, returned as a 500).

## 5. Testing

- **`tests/context-guard.test.ts`** (new): unit tests for `ensureCandidateFits()` directly — `"ok"` when the estimate fits (and asserts `decide` is NOT called), `"ok"` when `context_window_tokens` is unset, `"switched"` when the estimate exceeds the window and `decide` returns a different eligible candidate, `"exhausted"` when `decide` returns `selected_candidate_id: null`, `"exhausted"` when `decide` returns `requires_human_approval: true`.
- **`tests/chat.test.ts`**: new test simulating a large tool result that pushes iteration 2's estimate over the initially-selected candidate's `context_window_tokens`, with a `decide` mock that returns a different candidate on the second call — asserts `handleChat()` switches providers mid-loop (the second `complete()` call goes to the new provider) and the final result still carries the correct `selectedCandidateId`. A second new test covers the `"exhausted"`-with-partial-answer case: asserts the returned `reply` contains the prior partial content plus the incomplete-response marker.
- **`tests/agent-turn.test.ts`**: same two cases adapted to `AgentTurnResult`'s shape — a mid-loop switch test, and an `"exhausted"` test. Because `agent-turn.ts` has no pre-existing partial-answer path, this task also needs one exhausted-with-partial-text test and one exhausted-with-no-text-yet test (asserts the thrown error).

## 6. Out of scope

Everything below belongs to the two sub-projects that follow this one in the agreed sequence, not to this spec:
- Streaming responses (next sub-project — separate spec/plan).
- Conversation-history management / summarization / token-budget UX (third sub-project — separate spec/plan, and depends on multi-turn persistence, which doesn't exist yet for `/api/chat`).
- Any change to `src/token-estimate.ts`'s heuristic itself (chars/4 + fixed buffer) — unchanged, only called more often.
- Auto-detecting Ollama's real configured context window — `OLLAMA_CONTEXT_WINDOW` stays a manual env var, per the already-merged MADE context-capacity plan's Global Constraints.
