import asyncio
import os
import sys

import requests_mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from made_routing import Filter  # noqa: E402


def make_filter():
    f = Filter()
    f.valves.MADE_URL = "http://made:8000"
    f.valves.OPENWEBUI_URL = "http://open-webui:8080"
    f.valves.OPENWEBUI_TOKEN = "test-token"
    f.valves.CLASSIFIER_MODEL = "deepseek-v4-flash"
    return f


BRAND_MODEL = {
    "id": "deepseek",
    "meta": {"made_scores": {"brand": "deepseek"}},
}
TIER_MODELS = [
    {
        "id": "deepseek-v4-flash",
        "is_active": False,
        "meta": {
            "made_scores": {
                "brand": "deepseek",
                "cost_per_1k_tokens": 0.0005,
                "quality": 0.6,
                "latency": 0.9,
                "business_risk": 0.9,
                "context_window_tokens": 32000,
            }
        },
    },
    {
        "id": "deepseek-v4-pro",
        "is_active": False,
        "meta": {
            "made_scores": {
                "brand": "deepseek",
                "cost_per_1k_tokens": 0.003,
                "quality": 0.9,
                "latency": 0.6,
                "business_risk": 0.8,
                "context_window_tokens": 128000,
            }
        },
    },
]


def test_inlet_passes_through_when_model_is_already_a_tier():
    async def run():
        with requests_mock.Mocker() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list",
                json={"data": [BRAND_MODEL] + TIER_MODELS},
            )
            f = make_filter()
            body = {
                "model": "deepseek-v4-flash",
                "messages": [{"role": "user", "content": "hi"}],
            }

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["model"] == "deepseek-v4-flash"
            # Already a concrete tier — MADE must never be consulted.
            assert not any(
                req.url == "http://made:8000/decide" for req in m.request_history
            )

    asyncio.run(run())


def test_inlet_calls_made_and_substitutes_model_for_brand_selection():
    async def run():
        with requests_mock.Mocker() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list",
                json={"data": [BRAND_MODEL] + TIER_MODELS},
            )
            m.post(
                "http://open-webui:8080/api/chat/completions",
                json={"choices": [{"message": {"content": "high"}}]},
            )
            m.post(
                "http://made:8000/decide",
                json={
                    "decision_id": "d1",
                    "selected_candidate_id": "deepseek-v4-pro",
                    "requires_human_approval": False,
                    "ranking": [],
                    "excluded": [],
                    "technique_used": "topsis",
                    "policy_version": "1",
                },
            )
            f = make_filter()
            body = {
                "model": "deepseek",
                "messages": [{"role": "user", "content": "explain quantum computing rigorously"}],
            }

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["model"] == "deepseek-v4-pro"

            decide_requests = [
                req for req in m.request_history if req.url == "http://made:8000/decide"
            ]
            assert len(decide_requests) == 1
            payload = decide_requests[0].json()
            assert payload["task"]["complexity"] == "high"
            assert payload["decision_kind"] == "model_selection"
            candidate_ids = {c["id"] for c in payload["candidates"]}
            assert candidate_ids == {"deepseek-v4-flash", "deepseek-v4-pro"}

    asyncio.run(run())


def test_inlet_falls_back_to_cheapest_qualifying_tier_when_made_unreachable():
    async def run():
        with requests_mock.Mocker() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list",
                json={"data": [BRAND_MODEL] + TIER_MODELS},
            )
            m.post(
                "http://open-webui:8080/api/chat/completions",
                json={"choices": [{"message": {"content": "low"}}]},
            )
            m.post("http://made:8000/decide", exc=Exception("connection refused"))
            f = make_filter()
            body = {"model": "deepseek", "messages": [{"role": "user", "content": "hi"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["model"] == "deepseek-v4-flash"  # cheapest of the two tiers

    asyncio.run(run())


def test_inlet_returns_unchanged_body_when_no_scored_candidates_exist():
    """Regression test: brand with ≥2 non-target entries where none carry cost_per_1k_tokens.

    When cheapest_qualifying has no scored candidates to fall back to, inlet() must
    return body unchanged (with original model value), never raise an exception.
    This exercises the exact scenario from the Important finding.
    """
    async def run():
        # Two models with the same brand but neither has cost_per_1k_tokens
        unscored_models = [
            {
                "id": "unscored-model-1",
                "meta": {"made_scores": {"brand": "unscored-brand"}},
            },
            {
                "id": "unscored-model-2",
                "meta": {"made_scores": {"brand": "unscored-brand"}},
            },
        ]

        with requests_mock.Mocker() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list",
                json={"data": unscored_models},
            )
            m.post(
                "http://open-webui:8080/api/chat/completions",
                json={"choices": [{"message": {"content": "medium"}}]},
            )
            # MADE request would fail; trigger fallback path
            m.post("http://made:8000/decide", exc=Exception("connection refused"))

            f = make_filter()
            body = {
                "model": "unscored-brand",
                "messages": [{"role": "user", "content": "hello"}],
            }
            original_model = body["model"]

            # This must not raise ValueError from min() on empty pool.
            result = await f.inlet(body, __user__={"id": "u1"})

            # body["model"] should remain unchanged since no fallback was found
            assert result["model"] == original_model
            assert result is body  # returned the same dict

    asyncio.run(run())
