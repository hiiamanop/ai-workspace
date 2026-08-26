# PRD — Open WebUI integrations, governed by MADE

## Problem

Open WebUI (vendored under `open-webui/`) ships far more than chat + our
own Filter/Tools additions — Knowledge/RAG, image generation, audio,
terminal servers, pipelines, skills, and more. None of it currently goes
through MADE. The pattern already proven twice this session (model tier
routing, tool selection) is: Open WebUI exposes a registry of options with
metadata, a Filter reads that registry, asks MADE which option(s) apply,
rewrites the request. This doc surveys what else in Open WebUI fits that
pattern, and what doesn't.

## Survey (`open-webui/backend/open_webui/routers/`, `config.py`)

**Fits the MADE-governance pattern — a real "which option" decision:**

- **Knowledge/RAG** (`retrieval.py`) — Open WebUI already has its own
  vector-DB layer: `VECTOR_DB` (default `chroma`, also pgvector/
  mariadb-vector/oracle23ai) + `RAG_EMBEDDING_MODEL`
  (`sentence-transformers/...` by default). This is exactly why
  [[docs/PRD-confidentiality-pipeline.md]] **dropped its own vector store
  from scope** rather than standing up a second, competing one — redaction
  itself needs no vector DB at all (it's pure text processing), and a
  confidential-RAG feature isn't a real requirement yet. If it ever
  becomes one, it's scoped work on its own, not bundled into redaction.
- **Image generation** (`images.py`, `IMAGE_GENERATION_ENGINE`) — single
  configured engine today (default `openai`-shaped). If more than one
  image backend is ever configured, this becomes a MADE `tool_selection`
  candidate exactly like `web_search`/`scrape` — same `made_cost`/
  `made_quality`/... frontmatter pattern, same Filter mechanism. **Not
  worth building until a second image backend actually exists** — one
  option has nothing to route between.
- **Audio STT/TTS** (`audio.py`, `AUDIO_STT_ENGINE`/`AUDIO_TTS_ENGINE`) —
  same shape and same caveat as image generation: single-engine today,
  becomes MADE-relevant only once there's a real choice to make.

**High-risk, currently dormant — a real gap, not urgent:**

- **Terminal Servers** (`terminals.py`) — proxies to an *externally
  configured* shell/terminal server; genuinely dangerous if ever wired up
  (arbitrary command execution from chat). `MADE/policies/hard/
  security.rego` already has a `high_risk_tools := {"shell_exec"}` deny
  rule for exactly this class of capability — it's just never been
  exercised because nothing plays that role yet. **No terminal server is
  connected in this deployment today**, so this is a "know it's there"
  item, not a "build it now" item — revisit if/when a terminal server
  actually gets configured, and make sure whatever tool id it registers
  under lands in that deny rule's set.
- **Pipelines** (`pipelines.py`) — Open WebUI's general pre/post-processing
  plugin framework, same category as Filters. **This is the natural home
  for [[docs/PRD-confidentiality-pipeline.md]] Phase 3's
  `confidential_redaction.py`** — worth confirming during that phase
  whether it should be a Pipeline or a Filter (the plan currently assumes
  Filter, matching `made_routing.py`'s proven shape; Pipelines run as a
  separate process and may suit a heavier redaction step better — decide
  when Phase 3 starts, not now).

**Doesn't fit — no "which option" decision to arbitrate:**

- **Skills** (`skills.py`) — static, admin-managed reusable prompt/
  instruction snippets. No execution, no cost/quality/latency to score.
  Nothing for MADE to decide.
- **Notes, Memories, Calendar, Channels, Automations, SCIM** — productivity
  and collaboration features, not AI-request-shaped. Out of scope for a
  decision engine that routes model/tool/data choices.

## Recommendation

Don't build any of this speculatively.

1. Knowledge/RAG — resolved: no second vector store, redaction doesn't need
   one. Nothing further to do here unless confidential-RAG becomes a real
   request later.
2. Image/audio engine routing — **do nothing** until a second engine is
   actually configured for either. Building a MADE decision for a
   single-option registry is dead code.

The one real code item already has a home: confidentiality-pipeline
Phase 3 decides Filter-vs-Pipeline when it starts.

## Related docs

- [[docs/PRD.md]] — whole-app direction.
- [[docs/PRD-confidentiality-pipeline.md]] — where the vector-store decision
  and the Phase 3 Filter-vs-Pipeline decision belong.
