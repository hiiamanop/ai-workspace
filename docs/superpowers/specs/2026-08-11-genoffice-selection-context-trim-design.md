# Design: Trim GenOffice's AI-panel selection context more consistently

Status: approved by user (2026-08-11).
Split out from `docs/superpowers/specs/2026-08-11-made-context-capacity-design.md` as its own sub-project, since it touches GenOffice's own `protocol.ts` (kept untouched since the Univer→GenOffice replacement) rather than MADE or `agent-turn.ts`.

## 1. Background

Investigating whether GenOffice's AI panel sends too much document context per turn (raised after a real context-overflow failure, see the MADE spec above) found that the actual failure was caused by the static system prompt + tool schemas (~10,300 characters, paid every turn regardless of document size), not document content — `buildDocumentContext()` in `genoffice/apps/docs/src/renderer/ai/protocol.ts` already caps the document block list at `DOC_CONTEXT_MAX_CHARS = 8_000` with a considered strategy: progressively shorten per-block previews, then elide the middle blocks while keeping both ends (so block indexes stay verifiable and current context is preserved).

One real gap remains: the current text **selection**, sent via `SELECTION_MAX_CHARS = 24_000` (three times the document budget) using `clip()` — a naive cut at the character limit with `…` appended. For a "rewrite this selection" request, cutting off the tail risks truncating exactly the part the user meant to change, and the inconsistent, much larger budget undermines the same reasoning already applied to the document block list.

## 2. Change

In `genoffice/apps/docs/src/renderer/ai/protocol.ts`:
- Lower `SELECTION_MAX_CHARS` from `24_000` to `8_000`, matching `DOC_CONTEXT_MAX_CHARS`.
- Replace the selection's `clip()` call with a new small helper, `elideMiddle(text: string, max: number): string`: if `text.length <= max`, return unchanged; otherwise keep a prefix and a suffix (splitting the remaining budget roughly evenly, after reserving space for the marker) with `…(N chars elided here)…` in between, so the result never exceeds `max`.
- `buildDocContext()`'s selection line switches from `clip(serializeRangeToHtml(...), SELECTION_MAX_CHARS)` to `elideMiddle(serializeRangeToHtml(...), SELECTION_MAX_CHARS)`.

`buildDocumentContext()`'s existing block-list elision (which operates on an array of per-block lines, not a raw string) is untouched — it already does the right thing for that case and doesn't share a data shape with the selection's single HTML string, so no extraction/sharing between the two is forced.

No changes to `docs-skill.ts`, `tools.ts`, or anything outside `protocol.ts`.

## 3. Testing

New test cases in GenOffice's own `apps/docs` Vitest suite (find the existing test file covering `protocol.ts`, or add one alongside it) for `elideMiddle()`:
- Input shorter than `max` is returned unchanged.
- Input longer than `max` keeps a recognizable prefix and suffix from the original text, includes the elision marker, and the total result length is `<= max`.

No test changes needed for `buildDocumentContext()`'s existing block-elision behavior (unaffected).

## 4. Out of scope

- `buildDocumentContext()`'s block-list truncation strategy (already reasonable, not touched).
- Reducing the static system-prompt/tool-schema overhead paid every turn — that was the actual cause of the real failure investigated, but is a different, larger change to `docs-skill.ts`/`protocol.ts`'s prompt content and not part of this narrowly-scoped fix.
- Any form of true summarization (LLM-generated) of document or selection content — `elideMiddle` is a mechanical truncation, not a semantic one, consistent with `buildDocumentContext()`'s existing approach.
