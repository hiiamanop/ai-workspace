# Route Open WebUI's Chat Completions Through MADE — Design

## Goal

Make Open WebUI (deployed in Sub-project A', see
`docs/superpowers/specs/2026-08-12-openwebui-deploy-design.md`) call MADE's
`POST /decide` before dispatching a chat completion to a provider, instead
of using whatever model the user's dropdown selected verbatim (today's
actual behavior). This is the sub-project that turns "Open WebUI with a
provider connection" into "Open WebUI governed by MADE" — the whole reason
this project's own thesis-derived decision engine exists.

Bundled into this same effort (confirmed with the user, a deliberate
scope expansion beyond the original narrower plan):

- **Dynamic candidate discovery**: MADE's candidate pool for this
  integration is not a hardcoded list — it's built at request time from
  whatever models are currently active in Open WebUI's own model registry.
- **Task-difficulty classification**: MADE's only per-request task signal
  today is `estimated_context_tokens` (conversation length). This
  sub-project adds a real difficulty signal and extends MADE's own schema
  and TOPSIS weighting so that signal actually influences ranking, not
  just gets computed and discarded.

## Non-goals

- No changes to Open WebUI's own source under `open-webui/` — the
  integration is entirely a new Filter Function (Open WebUI's own
  extension mechanism) plus a provisioning script, both living in this
  repo outside `open-webui/`.
- No mandatory/blocking governance yet — if MADE is unreachable or
  declines to pick a candidate, the chat still proceeds (with the user's
  original model choice), it doesn't fail. Making governance hard-blocking
  is a future decision, not part of this sub-project.
- No UI changes in Open WebUI for displaying "why this model was chosen"
  to the end user — out of scope, a future enhancement.
- No changes to `MADE/policies/hard/*.rego` themselves (that's
  Sub-project C', the Policy authoring/compile pipeline) — this
  sub-project only adds the new `complexity` signal to MADE's schema and
  soft-ranking (TOPSIS/`epm.yaml`), it doesn't touch hard-constraint
  policy files.
- No per-user MADE identity/multi-tenant `org` context — every request
  uses the same static `org` block this project's own `src/chat.ts`
  already uses (single-org assumption, consistent with the rest of this
  project).

## Architecture

```
User sends a message in Open WebUI
  -> Open WebUI's inlet-filter stage runs (existing extension point,
     confirmed during research: runs before any provider dispatch, before
     Socket.IO streaming starts — no streaming-protocol complexity)
    -> MADE-routing Filter's inlet():
       (a) classify_complexity(): one fast call to a fixed, non-candidate
           cheap model, asking it to rate the current message's difficulty
       (b) collect_candidates(): query Open WebUI's own active model list;
           for each model, read governance scores from that model's own
           `meta` field (cost/quality/latency/business_risk — see
           "Candidate scores" below)
       (c) call MADE's POST /decide with decision_kind="model_selection",
           the collected candidates, and task context including the new
           complexity signal
       (d) on success: overwrite body["model"] with MADE's
           selected_candidate_id
           on any failure (MADE unreachable, no eligible candidate,
           requires_human_approval, classification timeout): leave
           body["model"] unchanged (the user's original pick), log why
    -> body returned, Open WebUI's own dispatch continues unmodified
```

### Filter provisioning

Open WebUI only executes Filter code that's stored in its own database
(the `Function` table) — there is no "drop a `.py` file in a folder and
it gets picked up" mechanism (confirmed during research: no seed-from-disk
loader exists anywhere in the vendored source). So:

- The Filter's Python source lives as a versioned file in this repo (path
  decided during planning — outside `open-webui/`, e.g. a new top-level
  `openwebui-filters/` directory), reviewable through this project's
  normal process.
- A small provisioning script (Node, consistent with this project's own
  stack) runs after the `open-webui` container is healthy. It logs in as
  a dedicated automation admin account (new `OPENWEBUI_ADMIN_EMAIL` /
  `OPENWEBUI_ADMIN_PASSWORD` vars in `.env` — NOT LLM keys, just this
  automation account's own login, parallel to how `WEBUI_SECRET_KEY` is
  documented as "not an LLM key" today) and calls Open WebUI's own
  `POST /api/v1/functions/sync` (confirmed idempotent — safe to re-run on
  every deploy, every volume reset, every Filter code update).
- This script is a manual step for now (run it yourself after
  `docker compose up`), not wired into container startup automatically —
  automating that trigger is a reasonable future refinement, not required
  for this sub-project's goal (governance actually working end-to-end).

### Candidate scores

Open WebUI's own model registry has no concept of cost/quality/latency/
business-risk (confirmed during research). Rather than maintaining a
separate config file that drifts from what's actually configured, scores
live in each Open WebUI Model's own `meta` field (an existing flexible
JSON field, already used for other model-level settings like `toolIds`) —
a new `meta.made_scores: { cost_per_1k_tokens, quality, latency,
business_risk, context_window_tokens }` object, editable via Open WebUI's
own existing Model edit UI (no new UI to build). Models with no
`made_scores` set get conservative default values (documented in the
implementation plan) rather than being excluded from the candidate pool
entirely — a newly-added model should be usable immediately, not silently
invisible to MADE until someone remembers to score it.

### Complexity classification

A single additional model call per user message, using a **fixed**
cheap/fast model configured directly in the Filter (not itself a MADE
candidate — avoids circularity: the classifier can't be subject to the
same routing decision it's informing). Prompted to return a short,
parseable signal (exact scale decided during planning — e.g. an integer
1-5, or a small enum). This signal becomes a new field on MADE's
`DecideRequest.task`.

**MADE-side change** (editing `ai-workspace/MADE/` — this project's own
vendored, already-previously-edited copy, per the correction made during
brainstorming; not the separate `/home/naufa/workspace/MODE` thesis repo):
`TaskIn` gains a `complexity` field (`core/decision/engine.py` and
wherever `TaskIn`'s schema is defined — exact location confirmed during
planning), and the TOPSIS/weighted-sum scoring in `core/modm/` is extended
so complexity actually shifts the ranking (e.g., high complexity increases
the effective weight on `quality`, or filters out below some quality
threshold) — the exact scoring adjustment is a planning-time detail, but
the requirement is: **a high-complexity task must be observably more
likely to rank a higher-quality candidate above a cheaper one**, not just
carry the field for show.

## Error handling

- MADE unreachable / times out: leave `body["model"]` untouched (fall
  back to the user's original selection), log the failure. Chat proceeds
  normally — this integration is advisory, not blocking, for now.
- MADE responds but `selected_candidate_id` is null or
  `requires_human_approval` is true: same fallback — untouched model,
  logged, chat proceeds.
- Complexity-classification call fails or times out: treat as a neutral/
  medium default, still proceed to call MADE (don't let a classifier
  hiccup block the whole routing attempt).
- MADE selects a candidate that turns out not to exist in Open WebUI's
  active model list (stale candidate pool, race with a model being
  disabled mid-request): fall back to the user's original selection.

## Testing

- The Filter's Python logic (candidate collection, MADE call, fallback
  branches) gets unit tests with a mocked MADE HTTP endpoint and mocked
  Open WebUI model list — verifiable without a running Open WebUI
  instance.
- The provisioning script gets tests verifying idempotency (running it
  twice doesn't error or duplicate the Function).
- MADE's new `complexity` field and its TOPSIS/weighted-sum effect get
  tests in `MADE/tests/` (existing test suite there) proving a
  high-complexity task's ranking differs from a low-complexity one given
  the same candidate pool.
- One manual end-to-end verification: send a real chat in Open WebUI,
  confirm via MADE's own logs/decision record that `/decide` was actually
  called and the model that responded matches what MADE selected — not
  silently still the user's original dropdown pick.

## Out of reach

- Sub-project C' (Policy workspace category, compile-to-Rego pipeline) —
  unrelated to this sub-project's scope beyond both eventually touching
  MADE.
- Sub-project D' (GenOffice/tools integration inside Open WebUI).
- Automatic provisioning-script triggering on container startup.
- Hard-blocking governance (chat refusing to proceed when MADE declines).
- Any UI surfacing of "why was this model picked" to the end user.
