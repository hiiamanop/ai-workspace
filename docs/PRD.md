# PRD — ai-workspace

## What this is

A self-hosted "superapp" where every AI-facing decision — which model
answers a request, which tools it may use, whether a request needs human
approval, and (as of this doc) whether data may leave the process at all —
is made by **MADE**, a separate policy engine (Rego hard constraints +
TOPSIS/weighted-sum soft ranking over cost/quality/latency/business-risk),
not hardcoded into the app. The app is the surface; MADE is the decision
maker. Nothing calls a model provider or executes a tool without MADE
approving it first.

## Where it's been (shipped, in commit order)

1. **Foundation** — Node/TS backend (`src/chat.ts`) + a custom React chat UI,
   MADE's `/decide` wired in for model/tool selection, streaming over
   WebSocket, resumable turns, inline web-search citations, mid-conversation
   context-capacity re-checks (`src/context-guard.ts`).
2. **Open WebUI adopted as the primary UI** (sub-projects A'–D'), because it
   already solves chat UX, auth, and multi-model plumbing better than a
   bespoke React app would:
   - **A'** — deploy Open WebUI alongside this app via Docker Compose.
   - **B'** — a MADE-routing Open WebUI *Filter* (`openwebui-filters/
     made_routing.py`) that intercepts chat requests and asks MADE's
     `/decide` which model tier to actually dispatch to, instead of trusting
     the user's raw model pick.
   - **C** — an admin-only Policy authoring workspace inside Open WebUI
     (Markdown/Rego split-pane editor, live compile, versioning, rollback,
     audit log) so policy changes don't require redeploying MADE by hand.
   - **D** — `web_search`/`scrape` registered as native Open WebUI Tools
     (calling back into this app's own `/api/*` routes).
3. **Ollama → full API-token models.** Ollama is dropped from every code
   path (`candidates.ts`, `chat.ts`, compose, env). DeepSeek is now the only
   model candidate. This removed Ollama's *incidental* confidentiality
   guarantee (nothing sensitive could leave the machine because the model
   itself never left the machine) — which is what led directly to the next
   item.

## Where it's going now

**The confidentiality pipeline** (see [[docs/PRD-confidentiality-pipeline.md]],
[[docs/SYSTEM_DESIGN.md]], [[docs/SCHEMA.md]]) restores that guarantee at the
right layer — data transformation, not vendor choice. MADE gains a
`core/privacy/` subsystem: regex + NER detection, reversible pseudonymization
with a persistent per-org mapping store, and a Qdrant-backed vector store so
confidential RAG content is retrievable without ever being forwarded to an
external model as raw text. MADE's existing (but previously inert) hard
constraints — `compliance.rego`/`privacy.rego`, which already deny specific
vendors for confidential/restricted `data_classification` — become the real
enforcement gate: confidential data reaching an external vendor without
`task.redacted == true` gets denied, the same mechanical way an
undersized context window gets denied today.

This is being built root-first: MADE's privacy core and policy tightening
land before any caller (Open WebUI's chat path, this app's own `chat.ts`,
web_search/scrape RAG ingestion) is wired to use it — see the follow-up
phases in [[docs/PRD-confidentiality-pipeline.md]].

## Direction, stated plainly

- **MADE is the constant.** Every new capability (redaction, RAG, future
  additions) is added as something MADE *decides about or enforces*, not as
  ad-hoc logic in the Node app or in Open WebUI. That's the "decision maker"
  framing the user set at the start of this work.
- **Open WebUI is the primary surface**, not the bespoke React chat page —
  new user-facing capability goes there first (Filters, Tools, workspace
  tabs) unless there's a specific reason it can't.
- **Confidentiality is now a data problem, not a vendor problem.** Any
  future model/vendor addition doesn't need a "is this local enough to
  trust" judgment call — it needs the redaction gate to be satisfied, which
  is vendor-agnostic by design.

## Related docs

- [[docs/PRD-confidentiality-pipeline.md]] — current work in detail.
- [[docs/SYSTEM_DESIGN.md]], [[docs/SCHEMA.md]] — confidentiality pipeline
  design and shapes.
- Repo's own `CLAUDE.md` — architecture reference and command list, kept
  current as the source of truth for "how do I run this."
