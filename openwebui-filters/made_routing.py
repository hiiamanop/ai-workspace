"""
Open WebUI inlet Filter that routes chat completions through MADE's
POST /decide instead of using the user's raw model selection verbatim.

This file is the SOURCE OF TRUTH — src/openwebui-provision.ts installs this
exact content into Open WebUI's own database via its Functions API. Editing
Open WebUI's Function directly through its admin UI will be silently
overwritten the next time the provisioning script runs.

Model registry shape this Filter expects from Open WebUI's
GET /api/v1/models/list: each model's `meta.made_scores` either
  - identifies a "brand" pseudo-model the user picks from the UI
    (only a `brand` key, no `cost_per_1k_tokens`), or
  - identifies a concrete, MADE-scored "tier" the brand can route to
    (`brand` plus `cost_per_1k_tokens`, `quality`, `latency`,
    `business_risk`, `context_window_tokens`).
Whether `body["model"]` names a brand or an already-concrete tier is
determined by that presence/absence of `cost_per_1k_tokens` on the
matching registry entry, not by list position or count.

Complexity classification: `_classify_complexity()` calls MADE's own
POST /classify (a small local HF model, not an LLM) to rate the latest
user message low/medium/high before asking MADE which model tier to route
to. Falls back to "medium" if MADE is unreachable.

Data classification: reads `body["_privacy"]` — `{"data_classification":
"confidential", "redacted": true}` if `confidential_redaction.py` (a
separate Filter, priority -10 so it runs first) actually redacted
something in this request. Absent (that Filter not installed, or nothing
sensitive found) falls back to `"internal"`/not-redacted, same behavior as
before that Filter existed.

Tool selection: if the client sends `"auto"` in `body["tool_ids"]` (a
sentinel the chat UI's "Auto (MADE decides)" toggle sends instead of real
tool ids), this Filter fetches Open WebUI's tool registry
(GET /api/v1/tools/, unpaginated) and reads MADE scores off each tool's
`meta.manifest` — flat string keys `made_cost`, `made_quality`,
`made_latency`, `made_business_risk` (Open WebUI derives meta.manifest by
re-parsing a docstring frontmatter block of `key: value` lines at the top
of the tool's own Python source on every create/update — it discards
whatever meta.manifest you POST directly, so scores can't live there as a
nested dict the way model `meta.made_scores` do; key names must also be
pure [a-z_]+, no digits, or the line silently fails to parse — e.g.
`made_cost_per_1k_tokens` would never appear). It asks MADE's
tool_selection decision and replaces `body["tool_ids"]` with every id in
the response's `ranking` (not just the top one — unlike model selection,
multiple tools can be usable in one turn). If MADE can't be reached or
returns no ranked tools, tool_ids becomes `[]` — fails closed, since there
is no safe "cheapest tool" fallback the way there is for models.
"""
import aiohttp
from pydantic import BaseModel

# Surfaced to the user (as an Open WebUI error bubble) when a
# confidential/restricted request has no approved model — e.g. sensitive
# prose with nothing redactable, or a detected secret. Better an explicit
# "can't send this" than a silent downgrade to a cheap external tier.
BLOCKED_MESSAGE = (
    "This message looks confidential and can't be safely sent to an external "
    "model. Remove the sensitive details and try again, or ask an admin to "
    "configure a trusted model."
)


class Filter:
    class Valves(BaseModel):
        MADE_URL: str = "http://made:8000"
        OPENWEBUI_URL: str = "http://open-webui:8080"
        OPENWEBUI_TOKEN: str = ""
        REQUEST_TIMEOUT_SECONDS: float = 8.0

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body: dict, __user__: dict = None) -> dict:
        if "auto" in (body.get("tool_ids") or []):
            body["tool_ids"] = await self._route_tools(body)

        model_id = body.get("model", "")
        try:
            models = await self._list_models()
        except Exception as err:
            print(f"MADE routing: model list fetch failed: {err}")
            return body  # can't even see the model registry — leave untouched

        target = next((m for m in models if m.get("id") == model_id), None)
        if target is None:
            return body  # unknown model id — nothing to route

        target_scores = target.get("meta", {}).get("made_scores", {})
        if target_scores.get("cost_per_1k_tokens") is not None:
            # model_id already names a concrete, scored tier — nothing to route
            return body

        brand = target_scores.get("brand")
        if not brand:
            return body  # not a brand pointer either — unknown shape, leave untouched

        brand_candidates = [
            m for m in models
            if _brand_of(m) == brand and m.get("id") != model_id
        ]
        if not brand_candidates:
            return body

        complexity = await self._classify_complexity(body)
        is_sensitive = (body.get("_privacy") or {}).get("data_classification") in (
            "confidential",
            "restricted",
        )

        selected = None
        try:
            selected = await self._call_made(brand_candidates, complexity, body)
        except Exception as err:
            print(f"MADE routing: /decide call failed: {err}")

        if selected and any(c["id"] == selected for c in brand_candidates):
            body["model"] = selected
            return body

        # No model was approved. For confidential/restricted data this is a
        # hard stop — never silently fall back to a cheap external tier with
        # sensitive content (that would defeat external_vendor.rego /
        # restricted.rego). Raising surfaces BLOCKED_MESSAGE to the user.
        if is_sensitive:
            raise Exception(BLOCKED_MESSAGE)

        print("MADE routing: no selection, falling back to cheapest tier")
        fallback_model = _cheapest_qualifying(brand_candidates)
        if fallback_model is not None:
            body["model"] = fallback_model
        return body

    async def _route_tools(self, body: dict) -> list[str]:
        try:
            tools = await self._list_tools()
        except Exception as err:
            print(f"MADE routing: tool list fetch failed: {err}, no tools will be used")
            return []

        candidates = []
        for t in tools:
            # Open WebUI re-derives meta.manifest from a `"""key: value"""`
            # frontmatter block at the top of the tool's own source on every
            # create/update — values arrive as plain strings, not a nested dict.
            manifest = t.get("meta", {}).get("manifest", {})
            if "made_cost" not in manifest:
                continue  # tool has no MADE scores — MADE has nothing to rank it on
            try:
                cost = float(manifest.get("made_cost", 0))
                quality = float(manifest.get("made_quality", 0.5))
                latency = float(manifest.get("made_latency", 0.5))
                business_risk = float(manifest.get("made_business_risk", 0.5))
            except (TypeError, ValueError):
                continue  # malformed scores — skip rather than send garbage to MADE
            candidates.append({
                "id": t["id"],
                "vendor": t["id"],
                "kind": "tool",
                "cost_per_1k_tokens": cost,
                "scores": {
                    "cost": cost,
                    "quality": quality,
                    "latency": latency,
                    "business_risk": business_risk,
                },
            })
        if not candidates:
            return []

        try:
            return await self._call_made_tools(candidates, body)
        except Exception as err:
            print(f"MADE routing: tool /decide call failed: {err}, no tools will be used")
            return []

    async def _list_tools(self) -> list[dict]:
        """Fetch all tools (plain array response, no pagination)."""
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self.valves.OPENWEBUI_URL}/api/v1/tools/",
                headers={"Authorization": f"Bearer {self.valves.OPENWEBUI_TOKEN}"},
                timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS),
            ) as resp:
                resp.raise_for_status()
                tools = await resp.json()
                if not isinstance(tools, list):
                    raise ValueError(f"Expected a list response, got {type(tools).__name__}")
                return tools

    async def _call_made_tools(self, candidates: list[dict], body: dict) -> list[str]:
        estimated_tokens = sum(len(m.get("content", "")) for m in body.get("messages", [])) // 4

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.valves.MADE_URL}/decide",
                json={
                    "task": {
                        "type": "chat",
                        # Hardcoded to "internal" — same documented scope limitation as model routing above.
                        "data_classification": "internal",
                        "estimated_context_tokens": estimated_tokens,
                    },
                    "decision_kind": "tool_selection",
                    "candidates": candidates,
                },
                timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS),
            ) as resp:
                resp.raise_for_status()
                decision = await resp.json()
                if decision.get("requires_human_approval"):
                    return []
                return [entry["id"] for entry in decision.get("ranking", [])]

    async def _list_models(self) -> list[dict]:
        """Fetch all models, paging through results (30 per page)."""
        all_models = []
        page = 1
        async with aiohttp.ClientSession() as session:
            while True:
                async with session.get(
                    f"{self.valves.OPENWEBUI_URL}/api/v1/models/list?page={page}",
                    headers={"Authorization": f"Bearer {self.valves.OPENWEBUI_TOKEN}"},
                    timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS),
                ) as resp:
                    resp.raise_for_status()
                    body = await resp.json()
                    if not isinstance(body, dict):
                        raise ValueError(f"Expected dict response, got {type(body).__name__}")
                    items = body.get("items", [])
                    if not isinstance(items, list):
                        raise ValueError(f"Expected items to be a list, got {type(items).__name__}")
                    all_models.extend(items)
                    total = body.get("total", 0)
                    if len(items) < 30 or len(all_models) >= total:
                        break
                    page += 1
        return all_models

    async def _classify_complexity(self, body: dict) -> str:
        """Ask MADE's /classify — a small local HF model (deberta-v3-small,
        ~100M params), not an LLM call. Correctly separates prompt *length*
        from task *difficulty* (a long-but-easy prompt still comes back
        "low"; a short-but-hard one still comes back "high"), which a
        length-only heuristic cannot do. ~30-60ms on CPU once warmed up —
        no per-message API cost, unlike asking a chat model to self-report.
        """
        last_user_message = next(
            (m["content"] for m in reversed(body.get("messages", [])) if m.get("role") == "user"),
            "",
        )
        if not last_user_message:
            return "medium"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.valves.MADE_URL}/classify",
                    json={"text": last_user_message},
                    timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS),
                ) as resp:
                    resp.raise_for_status()
                    data = await resp.json()
                    complexity = data.get("complexity")
                    return complexity if complexity in ("low", "medium", "high") else "medium"
        except Exception as err:
            print(f"MADE routing: complexity classification failed: {err}, defaulting to medium")
            return "medium"

    async def _call_made(self, brand_candidates: list[dict], complexity: str, body: dict) -> str | None:
        candidates = []
        for m in brand_candidates:
            scores = m.get("meta", {}).get("made_scores", {})
            if "brand" not in scores or scores.get("cost_per_1k_tokens") is None:
                continue  # skip the brand entry itself and any un-scored model
            candidates.append({
                "id": m["id"],
                "vendor": scores.get("brand", "unknown"),
                "kind": "model",
                "cost_per_1k_tokens": scores.get("cost_per_1k_tokens", 0.01),
                "scores": {
                    "cost": scores.get("cost_per_1k_tokens", 0.01),
                    "quality": scores.get("quality", 0.5),
                    "latency": scores.get("latency", 0.5),
                    "business_risk": scores.get("business_risk", 0.5),
                },
                "context_window_tokens": scores.get("context_window_tokens"),
            })

        estimated_tokens = sum(len(m.get("content", "")) for m in body.get("messages", [])) // 4

        # confidential_redaction.py (if installed and it ran first — see its
        # own Valves.priority) sets this when it actually redacted something.
        # Absent means either that Filter isn't installed or found nothing
        # sensitive — "internal"/not-redacted, same as before this existed.
        privacy = body.get("_privacy", {})
        data_classification = privacy.get("data_classification", "internal")
        redacted = privacy.get("redacted", False)

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.valves.MADE_URL}/decide",
                json={
                    "task": {
                        "type": "chat",
                        "data_classification": data_classification,
                        "estimated_context_tokens": estimated_tokens,
                        "complexity": complexity,
                        "redacted": redacted,
                    },
                    "decision_kind": "model_selection",
                    "candidates": candidates,
                },
                timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS),
            ) as resp:
                resp.raise_for_status()
                decision = await resp.json()
                if decision.get("requires_human_approval"):
                    return None
                return decision.get("selected_candidate_id")


def _brand_of(model: dict) -> str | None:
    return model.get("meta", {}).get("made_scores", {}).get("brand")


def _cheapest_qualifying(brand_candidates: list[dict], min_quality: float = 0.4) -> str | None:
    scored = [
        (m["id"], m.get("meta", {}).get("made_scores", {}))
        for m in brand_candidates
        if m.get("meta", {}).get("made_scores", {}).get("cost_per_1k_tokens") is not None
    ]
    if not scored:
        return None  # no scored candidates to fall back to
    qualifying = [(mid, s) for mid, s in scored if s.get("quality", 0) >= min_quality]
    pool = qualifying if qualifying else scored
    return min(pool, key=lambda pair: pair[1].get("cost_per_1k_tokens", 999))[0]
