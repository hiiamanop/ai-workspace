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
  from scope** rather than standing up a second, competing one. **Built:**
  a `knowledge_search` External Tool (`src/openwebui-provision-tools.ts`)
  that *calls* Open WebUI's existing RAG via `POST /api/v1/retrieval/
  query/collection` — this is not a second vector store, it's MADE
  governing *whether to search the one that already exists*, same as any
  other tool. `read_file` (`GET /api/v1/files/{id}/data/content`) is the
  companion for reading a specific attached file's extracted content
  rather than searching Knowledge collections.
- **Image generation** (`images.py`, `IMAGE_GENERATION_ENGINE`) — two
  separable questions, don't conflate them: *whether to expose generation
  as a callable tool at all* (built: `generate_image`, calling
  `POST /api/v1/images/generations`) vs. *routing between multiple image
  backends* (still not worth building — only one engine is configurable
  today, nothing to route between). `generate_image` will 403 until the
  user configures an actual image backend in Admin Settings — that's a
  config choice, not something this repo does for them.
- **Memories** (`memories.py`) — **not** wired the way the other three
  are. Tools only receive `__user__` as profile data, never an auth token,
  so a Tool can't call Open WebUI's own per-user memories API on a
  specific user's behalf. Built as ai-workspace's own feature instead
  (`src/memory-store.ts`, a `memory` Tool with `remember`/`recall`
  methods) — see `CLAUDE.md`'s "Why not proxy to Open WebUI's own
  `memories.py`" note for the full reasoning.
- **Audio STT/TTS** (`audio.py`, `AUDIO_STT_ENGINE`/`AUDIO_TTS_ENGINE`) —
  still not built: single-engine today, and unlike image generation
  there's no immediate use case pulling it in yet. Same "expose as a tool"
  vs. "route between engines" distinction would apply if it is built.

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
- **Notes, Calendar, Channels, Automations, SCIM** — productivity and
  collaboration features, not AI-request-shaped. Out of scope for a
  decision engine that routes model/tool/data choices.

## Recommendation

1. Knowledge/RAG, image generation, memory — **built**, as External Tools
   (`knowledge_search`, `read_file`, `generate_image`, `memory`), all
   toggleable via the same "Auto" MADE `tool_selection` mechanism as
   `web_search`/`scrape`. No second vector store, no proxy to a
   memories API that can't be scoped per-user.
2. Audio and image/audio *engine routing* (as opposed to exposing
   generation as a tool, which is done) — still **do nothing** until a
   second engine is actually configured for either. Building a MADE
   decision for a single-option registry is dead code.

The one remaining real code item has a home: confidentiality-pipeline
Phase 3 decides Filter-vs-Pipeline when it starts.

## Related docs

- [[docs/PRD.md]] — whole-app direction.
- [[docs/PRD-confidentiality-pipeline.md]] — where the vector-store decision
  and the Phase 3 Filter-vs-Pipeline decision belong.
