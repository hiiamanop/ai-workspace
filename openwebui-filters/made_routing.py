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
"""
import aiohttp
from pydantic import BaseModel


class Filter:
    class Valves(BaseModel):
        MADE_URL: str = "http://made:8000"
        OPENWEBUI_URL: str = "http://open-webui:8080"
        OPENWEBUI_TOKEN: str = ""
        CLASSIFIER_MODEL: str = "deepseek-v4-flash"
        REQUEST_TIMEOUT_SECONDS: float = 8.0

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body: dict, __user__: dict = None) -> dict:
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
        try:
            selected = await self._call_made(brand_candidates, complexity, body)
            if selected and any(c["id"] == selected for c in brand_candidates):
                body["model"] = selected
                return body
        except Exception as err:
            print(f"MADE routing: /decide call failed: {err}, falling back to cheapest tier")

        fallback_model = _cheapest_qualifying(brand_candidates)
        if fallback_model is not None:
            body["model"] = fallback_model
        return body

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
        last_user_message = next(
            (m["content"] for m in reversed(body.get("messages", [])) if m.get("role") == "user"),
            "",
        )
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.valves.OPENWEBUI_URL}/api/chat/completions",
                    headers={"Authorization": f"Bearer {self.valves.OPENWEBUI_TOKEN}"},
                    json={
                        "model": self.valves.CLASSIFIER_MODEL,
                        "messages": [
                            {
                                "role": "system",
                                "content": "Rate the complexity of the user's message as exactly one word: low, medium, or high. Reply with only that word.",
                            },
                            {"role": "user", "content": last_user_message},
                        ],
                        "stream": False,
                    },
                    timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS),
                ) as resp:
                    resp.raise_for_status()
                    data = await resp.json()
                    text = data["choices"][0]["message"]["content"].strip().lower()
                    return text if text in ("low", "medium", "high") else "medium"
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

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.valves.MADE_URL}/decide",
                json={
                    "task": {
                        "type": "chat",
                        "data_classification": "internal",
                        "estimated_context_tokens": estimated_tokens,
                        "complexity": complexity,
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
