import asyncio
import os
import sys

from aioresponses import aioresponses

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import made_routing  # noqa: E402
from made_routing import Filter  # noqa: E402


def make_filter():
    f = Filter()
    f.valves.MADE_URL = "http://made:8000"
    f.valves.OPENWEBUI_URL = "http://open-webui:8080"
    f.valves.OPENWEBUI_TOKEN = "test-token"
    return f


TOOLS = [
    {
        "id": "web_search",
        "meta": {
            "manifest": {
                "made_cost": "0",
                "made_quality": "0.7",
                "made_latency": "3000",
                "made_business_risk": "0.2",
            }
        },
    },
    {
        "id": "scrape",
        "meta": {
            "manifest": {
                "made_cost": "0",
                "made_quality": "0.7",
                "made_latency": "6000",
                "made_business_risk": "0.3",
            }
        },
    },
]


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
                "latency": 0.1,
                "business_risk": 0.1,
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
                "latency": 0.4,
                "business_risk": 0.2,
                "context_window_tokens": 128000,
            }
        },
    },
]


def test_inlet_passes_through_when_model_is_already_a_tier():
    async def run():
        with aioresponses() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": [BRAND_MODEL] + TIER_MODELS, "total": 3},
            )
            # Explicitly fail if MADE is called (regression guard)
            m.post(
                "http://made:8000/decide",
                exception=Exception("MADE should never be consulted for a concrete tier model"),
            )
            f = make_filter()
            body = {
                "model": "deepseek-v4-flash",
                "messages": [{"role": "user", "content": "hi"}],
            }

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["model"] == "deepseek-v4-flash"
            # Already a concrete tier — MADE must never be consulted.
            # Verify no requests were made to MADE by iterating through actual request keys
            # aioresponses stores requests as: {(method, URL): [RequestCall, ...]}
            decide_requests_found = []
            for key in m.requests.keys():
                method, url = key
                if method == "POST" and "made:8000" in str(url) and "/decide" in str(url):
                    decide_requests_found.append(key)

            assert (
                not decide_requests_found
            ), "MADE's /decide should never be called for an already-concrete tier model"

    asyncio.run(run())


def test_inlet_calls_made_and_substitutes_model_for_brand_selection():
    async def run():
        with aioresponses() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": [BRAND_MODEL] + TIER_MODELS, "total": 3},
            )
            m.post(
                "http://made:8000/decide",
                payload={
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

    asyncio.run(run())


def test_inlet_falls_back_to_cheapest_qualifying_tier_when_made_unreachable():
    async def run():
        with aioresponses() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": [BRAND_MODEL] + TIER_MODELS, "total": 3},
            )
            m.post("http://made:8000/decide", exception=Exception("connection refused"))
            f = make_filter()
            body = {"model": "deepseek", "messages": [{"role": "user", "content": "hi"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["model"] == "deepseek-v4-flash"  # cheapest of the two tiers

    asyncio.run(run())


def test_inlet_sends_raw_cost_values_to_made_not_inverted():
    """Regression test: cost scores sent to MADE must be raw values (lower=better), not inverted goodness scores.

    Inspects the actual HTTP request payload sent to MADE's /decide endpoint to verify
    that candidate scores include raw cost values (0.0005, 0.003), not inverted values.
    """
    async def run():
        from urllib.parse import urlparse
        with aioresponses() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": [BRAND_MODEL] + TIER_MODELS, "total": 3},
            )
            # MADE receives flash's raw cost (0.0005) and pro's raw cost (0.003)
            # Since cost direction is minimize, MADE should select the cheapest: flash
            m.post(
                "http://made:8000/decide",
                payload={
                    "decision_id": "d1",
                    "selected_candidate_id": "deepseek-v4-flash",
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
                "messages": [{"role": "user", "content": "hi"}],
            }

            result = await f.inlet(body, __user__={"id": "u1"})

            # Flash should be selected (cheapest tier)
            assert result["model"] == "deepseek-v4-flash"

            # Verify costs were sent as raw values by inspecting the actual request to MADE
            # aioresponses stores requests as: {(method, URL): [RequestCall, ...]}
            # where RequestCall has kwargs with the json payload
            decide_url_key = None
            for key in m.requests.keys():
                method, url = key
                if method == "POST" and "made:8000" in str(url) and "/decide" in str(url):
                    decide_url_key = key
                    break

            assert decide_url_key, "MADE's /decide endpoint should have been called"

            # Get the request calls for the /decide endpoint
            decide_calls = m.requests[decide_url_key]
            assert len(decide_calls) > 0, "MADE's /decide should have been called"

            # Extract the JSON payload from the first call
            request_call = decide_calls[0]
            request_body = request_call.kwargs.get("json")
            assert request_body, "Request should have a JSON payload"

            # Verify the candidates and their cost scores
            assert "candidates" in request_body, "Request should have candidates"
            candidates = request_body["candidates"]

            # Find flash and pro candidates by their IDs
            flash_candidate = next(
                (c for c in candidates if c.get("id") == "deepseek-v4-flash"),
                None,
            )
            pro_candidate = next(
                (c for c in candidates if c.get("id") == "deepseek-v4-pro"),
                None,
            )

            # Verify raw cost values (not inverted)
            assert flash_candidate, "flash candidate should exist in request"
            assert "scores" in flash_candidate, "flash candidate should have scores"
            assert (
                flash_candidate["scores"].get("cost") == 0.0005
            ), f"Flash cost should be 0.0005 (raw), got {flash_candidate['scores'].get('cost')}"

            assert pro_candidate, "pro candidate should exist in request"
            assert "scores" in pro_candidate, "pro candidate should have scores"
            assert (
                pro_candidate["scores"].get("cost") == 0.003
            ), f"Pro cost should be 0.003 (raw), got {pro_candidate['scores'].get('cost')}"

    asyncio.run(run())


def test_inlet_handles_paginated_model_lists():
    """Regression test: model list pagination must work correctly (30 per page)."""
    async def run():
        # Create 45 models (more than one page of 30)
        page1_models = [
            {"id": f"model-{i}", "meta": {"made_scores": {"brand": "test"}}}
            for i in range(30)
        ]
        page2_models = [
            {"id": f"model-{i}", "meta": {"made_scores": {"brand": "test"}}}
            for i in range(30, 45)
        ]

        with aioresponses() as m:
            # Page 1
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": page1_models, "total": 45},
            )
            # Page 2
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=2",
                payload={"items": page2_models, "total": 45},
            )
            f = make_filter()

            models = await f._list_models()

            # Should have collected all 45 models across both pages
            assert len(models) == 45
            model_ids = {m["id"] for m in models}
            expected_ids = {f"model-{i}" for i in range(45)}
            assert model_ids == expected_ids

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

        with aioresponses() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": unscored_models, "total": 2},
            )
            # MADE request would fail; trigger fallback path
            m.post("http://made:8000/decide", exception=Exception("connection refused"))

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


def test_inlet_routes_tools_via_made_when_auto_selected():
    async def run():
        with aioresponses() as m:
            m.get("http://open-webui:8080/api/v1/tools/", payload=TOOLS)
            m.post(
                "http://made:8000/decide",
                payload={
                    "decision_id": "d1",
                    "selected_candidate_id": None,
                    "requires_human_approval": False,
                    "ranking": [{"id": "web_search", "score": 0.9}],
                    "excluded": [{"id": "scrape", "reason": "not needed"}],
                    "technique_used": "topsis",
                    "policy_version": "1",
                },
            )
            f = make_filter()
            body = {
                "model": "deepseek-v4-flash",  # already a concrete tier — no model MADE call needed
                "tool_ids": ["auto"],
                "messages": [{"role": "user", "content": "search the web for nasi padang"}],
            }

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["tool_ids"] == ["web_search"]

    asyncio.run(run())


def test_inlet_tool_routing_fails_closed_when_made_unreachable():
    async def run():
        with aioresponses() as m:
            m.get("http://open-webui:8080/api/v1/tools/", payload=TOOLS)
            m.post("http://made:8000/decide", exception=Exception("connection refused"))
            f = make_filter()
            body = {
                "model": "deepseek-v4-flash",
                "tool_ids": ["auto"],
                "messages": [{"role": "user", "content": "hi"}],
            }

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["tool_ids"] == []

    asyncio.run(run())


def test_inlet_leaves_tool_ids_untouched_when_auto_not_present():
    async def run():
        with aioresponses() as m:
            f = make_filter()
            body = {
                "model": "deepseek-v4-flash",
                "tool_ids": ["web_search"],
                "messages": [{"role": "user", "content": "hi"}],
            }

            result = await f.inlet(body, __user__={"id": "u1"})

            # No requests should have been made for tool routing.
            assert result["tool_ids"] == ["web_search"]

    asyncio.run(run())


def test_classify_complexity_calls_made_classify_not_an_llm():
    async def run():
        with aioresponses() as m:
            m.post(
                "http://made:8000/classify",
                payload={"complexity": "high", "label": "COMPLEX", "score": 0.93},
            )
            f = make_filter()

            result = await f._classify_complexity(
                {"messages": [{"role": "user", "content": "prove the halting problem is undecidable"}]}
            )

            assert result == "high"
            posted = list(m.requests.values())[0][0].kwargs["json"]
            assert posted == {"text": "prove the halting problem is undecidable"}

    asyncio.run(run())


def test_classify_complexity_defaults_to_medium_when_made_unreachable():
    async def run():
        with aioresponses() as m:
            m.post("http://made:8000/classify", exception=Exception("connection refused"))
            f = make_filter()

            result = await f._classify_complexity({"messages": [{"role": "user", "content": "hi"}]})

            assert result == "medium"

    asyncio.run(run())


def test_inlet_reads_privacy_marker_and_forwards_it_to_made():
    async def run():
        with aioresponses() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": [BRAND_MODEL] + TIER_MODELS, "total": 3},
            )
            m.post(
                "http://made:8000/decide",
                payload={
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
                "messages": [{"role": "user", "content": "hi"}],
                "_privacy": {"data_classification": "confidential", "redacted": True},
            }

            await f.inlet(body, __user__={"id": "u1"})

            decide_key = next(
                key for key in m.requests if key[0] == "POST" and "made:8000" in str(key[1]) and "/decide" in str(key[1])
            )
            posted = m.requests[decide_key][0].kwargs["json"]
            assert posted["task"]["data_classification"] == "confidential"
            assert posted["task"]["redacted"] is True

    asyncio.run(run())


def test_inlet_blocks_sensitive_request_when_made_approves_no_model():
    async def run():
        with aioresponses() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": [BRAND_MODEL] + TIER_MODELS, "total": 3},
            )
            m.post(
                "http://made:8000/decide",
                payload={
                    "decision_id": "d1",
                    "selected_candidate_id": None,
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
                "messages": [{"role": "user", "content": "the acquisition closes friday"}],
                "_privacy": {"data_classification": "confidential", "redacted": False},
            }

            raised = None
            try:
                await f.inlet(body, __user__={"id": "u1"})
            except Exception as err:  # noqa: BLE001
                raised = err

            assert raised is not None and str(raised) == made_routing.BLOCKED_MESSAGE
            assert body["model"] == "deepseek"  # not silently downgraded

    asyncio.run(run())


def test_inlet_still_falls_back_to_cheapest_for_non_sensitive_no_selection():
    async def run():
        with aioresponses() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": [BRAND_MODEL] + TIER_MODELS, "total": 3},
            )
            m.post(
                "http://made:8000/decide",
                payload={
                    "decision_id": "d1",
                    "selected_candidate_id": None,
                    "requires_human_approval": False,
                    "ranking": [],
                    "excluded": [],
                    "technique_used": "topsis",
                    "policy_version": "1",
                },
            )
            f = make_filter()
            body = {"model": "deepseek", "messages": [{"role": "user", "content": "hi"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["model"] == "deepseek-v4-flash"

    asyncio.run(run())


def test_inlet_defaults_to_internal_not_redacted_when_privacy_marker_absent():
    async def run():
        with aioresponses() as m:
            m.get(
                "http://open-webui:8080/api/v1/models/list?page=1",
                payload={"items": [BRAND_MODEL] + TIER_MODELS, "total": 3},
            )
            m.post(
                "http://made:8000/decide",
                payload={
                    "decision_id": "d1",
                    "selected_candidate_id": "deepseek-v4-flash",
                    "requires_human_approval": False,
                    "ranking": [],
                    "excluded": [],
                    "technique_used": "topsis",
                    "policy_version": "1",
                },
            )
            f = make_filter()
            body = {"model": "deepseek", "messages": [{"role": "user", "content": "hi"}]}

            await f.inlet(body, __user__={"id": "u1"})

            decide_key = next(
                key for key in m.requests if key[0] == "POST" and "made:8000" in str(key[1]) and "/decide" in str(key[1])
            )
            posted = m.requests[decide_key][0].kwargs["json"]
            assert posted["task"]["data_classification"] == "internal"
            assert posted["task"]["redacted"] is False

    asyncio.run(run())
