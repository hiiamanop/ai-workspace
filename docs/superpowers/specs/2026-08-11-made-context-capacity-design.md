# Design: MADE context-capacity hard constraint

Status: approved by user (2026-08-11).
Spans two repos, both now vendored plainly inside `ai-workspace`'s monorepo (their own `.git` history removed earlier this session, matching how `genoffice/` was folded in): `ai-workspace/` (Node/TypeScript backend) and `ai-workspace/MADE/` (the decision engine, Python/FastAPI/OPA).

## 1. Background and goal

Live debugging of the GenOffice AI panel (Milestone 3's second sub-project) found that MADE always selects the free local Ollama model (`gemma4:12b`) over DeepSeek for document-AI requests, even when the request's system prompt + tool schemas + conversation history exceed what Ollama's configured context window (`num_ctx`, currently manually set via `OLLAMA_CONTEXT_LENGTH`) can hold. Ollama silently truncates (`finish_reason: "length"`) and returns empty content — surfacing in the UI as "The AI returned no content," with no indication of the real cause. Increasing `OLLAMA_CONTEXT_LENGTH` repeatedly is not a fix: it was tried twice (4096 → 8192) and the second, more demanding real request (a multi-turn "search the web and write an article" conversation) exceeded even 8192.

Root cause, confirmed via MADE's actual policy weights (`policies/epm.yaml`): `cost` (weight 0.3) and `latency` (weight 0.2) combined outweigh `quality`'s 0.4, and Ollama dominates both — so it wins the TOPSIS ranking despite DeepSeek's higher quality score, every time. None of MADE's four existing objectives (cost, quality, latency, business_risk) represent whether a candidate can structurally complete the request at all. This is not a bug in the policy weights — the policy is doing exactly what it's configured to do. The gap is that "can this candidate handle this request's size" was never modeled as a decision input anywhere.

**Goal:** teach MADE that context capacity is a feasibility question, not a quality trade-off — a candidate whose context window is too small for a request must never be selected, no matter how well it scores elsewhere.

## 2. Architecture: a new hard constraint, not a fifth TOPSIS objective

MADE already separates two kinds of decision input: **hard constraints** (OPA/Rego policies under `policies/hard/`, which can outright exclude a candidate — e.g. `cost.rego` denies a candidate whose `cost_per_1k_tokens` exceeds the org's remaining budget) and **soft objectives** (the weighted TOPSIS ranking in `policies/epm.yaml`, which trades off among candidates that already passed the hard constraints). Context capacity is a feasibility question exactly like budget — a candidate that cannot fit the request should never win a ranking, no matter how it scores elsewhere. It goes in `policies/hard/`, as a new `context.rego`, following `cost.rego`'s exact pattern (same `deny[reason]` structure, same input shape, same fail-open-when-data-is-missing posture). No changes to `core/modm/topsis.py`, `weighted_sum.py`, or `policies/epm.yaml` — MADE's ranking algorithms are already fully generic over `Candidate.scores: dict[str, float]`, so nothing there needs to change.

## 3. Schema changes

**MADE** (`api/schemas.py` and `core/decision/engine.py`, both need the same two fields added, matching the existing dual-model pattern already used for `Task`/`TaskIn`, `DecisionCandidate`/`CandidateIn`):
- `CandidateIn`/`DecisionCandidate` gains `context_window_tokens: int | None = None` — the candidate's context window, only meaningful for `kind: "model"` candidates.
- `TaskIn`/`Task` gains `estimated_context_tokens: int = 0` — the caller's estimate of how many tokens this specific request needs (prompt + expected response headroom). Default `0` means "unknown/not applicable," which the new rule treats as "don't constrain" (fail open).
- `core/decision/engine.py`'s `decide()` includes both new fields in the `input_doc` dict passed to `evaluate_hard_constraints()`.

**`policies/hard/context.rego`** (new):
```rego
package made.hard

deny[reason] {
    input.candidate.kind == "model"
    input.candidate.context_window_tokens > 0
    input.task.estimated_context_tokens > 0
    input.task.estimated_context_tokens > input.candidate.context_window_tokens
    reason := sprintf(
        "context: candidate '%s' window %v tokens < required %v",
        [input.candidate.id, input.candidate.context_window_tokens, input.task.estimated_context_tokens],
    )
}
```
The two `> 0` guards make this fail open: a candidate or task that doesn't supply these fields (e.g. `tool_selection` decisions, or any future caller that hasn't adopted this yet) is never affected. This lives in `policies/hard/`, which both `epm.yaml` and `epm-critical.yaml` share via the same `hard_dir` — no duplication needed for the critical-data-classification path.

**`ai-workspace`** (`src/types.ts`, `src/candidates.ts`):
- `CandidateIn` gains `context_window_tokens?: number`.
- `DecideRequest`'s task shape gains `estimated_context_tokens?: number`.
- `OLLAMA_CANDIDATE.context_window_tokens` is read from a new env var `OLLAMA_CONTEXT_WINDOW` (parsed as an integer; falls back to `4096`, Ollama's own real default, if unset) — this must be kept in sync by whoever configures `OLLAMA_CONTEXT_LENGTH` on the Ollama side; it is not queried automatically (Ollama does not reliably expose the server's effective configured context length via a stable API, and adding a startup network probe for this is not worth the complexity here).
- `DEEPSEEK_CANDIDATE.context_window_tokens = 1_000_000` — `deepseek-v4-flash`'s real, documented context window (confirmed against DeepSeek's own pricing/models page, not guessed). Never realistically at risk of exclusion.
- `WEB_SEARCH_CANDIDATE`/`SCRAPE_CANDIDATE` (both `kind: "tool"`) get no `context_window_tokens` — not applicable, and the Rego rule's `kind == "model"` guard means it's never evaluated for them anyway.

## 4. Token estimation

New small shared module, `src/token-estimate.ts`, exporting `estimateContextTokens(system: string, tools: unknown[], messages: unknown[]): number`. Approach: total character count across the serialized system prompt, JSON-serialized tool definitions, and all message contents, divided by 4 (a standard rough chars-per-token heuristic for English text — this is a feasibility check, not precise accounting, matching the spirit of `candidates.ts`'s own existing static score estimates), plus a fixed response-headroom buffer (the model needs room to actually answer, not just read the prompt — the real "kuliner Bandung" failure had a 500+ token completion). Both `src/chat.ts` and `src/agent-turn.ts` call this and pass the result as `task.estimated_context_tokens` in their `decideRequest()` calls — unified into one estimator now that both need it, rather than duplicating logic (unlike the earlier `truncateToolResult` case, there is no "don't touch `chat.ts`" constraint here — this feature legitimately touches both).

## 5. Error handling

When every model candidate fails the new context check, MADE returns `selected_candidate_id: null` with populated `excluded` entries (same shape as any other hard-constraint exclusion today) — `chat.ts`/`agent-turn.ts` already throw `"MADE returned no eligible candidate"` in this case (existing code, unchanged). This replaces today's silent empty-content failure with a clear, immediate error — a strict improvement, even though the error message itself isn't new. Surfacing MADE's specific per-candidate exclusion reasons (e.g. "context window too small") in the UI is a possible future refinement, not required here.

## 6. Testing

- **MADE**: `policies/hard/context_test.rego` (new), mirroring `cost_test.rego`'s style — one test asserting `deny` fires when a candidate's window is too small, one asserting `count(deny) == 0` when it fits, one asserting `count(deny) == 0` when either field is `0`/missing (the fail-open case). `tests/api/test_decide.py` gets one new integration test exercising the same scenario through the real `/decide` endpoint.
- **ai-workspace**: `tests/token-estimate.test.ts` (new) for `estimateContextTokens()`. `tests/candidates.test.ts` gets assertions that `OLLAMA_CANDIDATE`/`DEEPSEEK_CANDIDATE` carry the new field with the right values (including the `OLLAMA_CONTEXT_WINDOW` env-var override and its fallback). `chat.test.ts`/`agent-turn.test.ts` get an assertion that `decide()` is called with a non-zero `estimated_context_tokens` in their existing mocked-`decide` test scaffolding.

## 7. Out of scope

- Reducing what GenOffice's AI panel sends per turn (document context, system prompt trimming) — deferred to a separate future sub-project, explicitly agreed to be split out since it touches GenOffice's own `protocol.ts`/`docs-skill.ts` area (kept untouched since the original Univer→GenOffice replacement), not MADE or `agent-turn.ts`.
- Any change to `core/modm/topsis.py`, `core/modm/weighted_sum.py`, or `policies/epm.yaml`'s existing four objectives.
- Auto-detecting Ollama's actual configured context window at runtime — `OLLAMA_CONTEXT_WINDOW` is manually set and must be kept in sync by whoever configures Ollama.
- A real per-model tokenizer for exact token counts — the chars/4 heuristic is accepted as good enough for a feasibility gate.
