import asyncio
import copy
import os
import sys

from aioresponses import aioresponses

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from confidential_redaction import Filter  # noqa: E402

MADE = "http://made:8000"


def make_filter():
    f = Filter()
    f.valves.MADE_URL = MADE
    return f


def _classify(m, classification, repeat=True):
    m.post(f"{MADE}/privacy/classify", payload={"classification": classification}, repeat=repeat)


def _redact(m, redacted_text, count, repeat=True):
    m.post(
        f"{MADE}/privacy/redact",
        payload={"redacted_text": redacted_text, "redaction_count": count},
        repeat=repeat,
    )


def test_priority_defaults_to_run_before_made_routing():
    f = make_filter()
    assert f.valves.priority < 0


def test_inlet_redacts_and_marks_confidential():
    async def run():
        with aioresponses() as m:
            _classify(m, "confidential")
            _redact(m, "email [EMAIL_1]", 1)
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "email jane@example.com"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "email [EMAIL_1]"
            assert result["_privacy"] == {"data_classification": "confidential", "redacted": True}

    asyncio.run(run())


def test_inlet_marks_confidential_even_with_no_redactable_span():
    async def run():
        with aioresponses() as m:
            _classify(m, "confidential")
            _redact(m, "the acquisition closes friday", 0)
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "the acquisition closes friday"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["_privacy"] == {"data_classification": "confidential", "redacted": False}

    asyncio.run(run())


def test_inlet_marks_restricted():
    async def run():
        with aioresponses() as m:
            _classify(m, "restricted")
            _redact(m, "key: [SECRET_REDACTED]", 1)
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "key: sk-abcdef0123456789abcdef"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["_privacy"]["data_classification"] == "restricted"

    asyncio.run(run())


def test_inlet_no_privacy_marker_for_internal_text():
    async def run():
        with aioresponses() as m:
            _classify(m, "internal")
            _redact(m, "hi there", 0)
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "hi there"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "hi there"
            assert "_privacy" not in result

    asyncio.run(run())


def test_inlet_does_not_redact_internal_text():
    async def run():
        with aioresponses() as m:
            _classify(m, "internal")
            # no /privacy/redact registered — a call would raise
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "ping me at bob@example.com"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            # internal is allowed to reach the vendor; over-eager NER on casual
            # text does more harm than good, so leave it alone.
            assert result["messages"][0]["content"] == "ping me at bob@example.com"
            assert "_privacy" not in result

    asyncio.run(run())


def test_inlet_only_looks_at_user_role_messages():
    async def run():
        with aioresponses():
            f = make_filter()
            body = {
                "messages": [
                    {"role": "system", "content": "you are helpful"},
                    {"role": "assistant", "content": "previous reply"},
                ]
            }

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "you are helpful"
            assert "_privacy" not in result

    asyncio.run(run())


def test_inlet_leaves_body_untouched_when_classify_unreachable():
    async def run():
        with aioresponses() as m:
            m.post(f"{MADE}/privacy/classify", exception=Exception("connection refused"))
            # classify down -> treat as internal -> no redaction, no _privacy
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "email jane@example.com"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "email jane@example.com"
            assert "_privacy" not in result

    asyncio.run(run())


def test_inlet_does_not_re_call_made_for_a_message_seen_before():
    async def run():
        with aioresponses() as m:
            _classify(m, "confidential", repeat=False)
            _redact(m, "email [EMAIL_1]", 1, repeat=False)
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "email jane@example.com"}]}

            await f.inlet(copy.deepcopy(body), __user__={"id": "u1"})
            result = await f.inlet(copy.deepcopy(body), __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "email [EMAIL_1]"

    asyncio.run(run())


def test_outlet_restores_placeholders_in_all_messages():
    async def run():
        with aioresponses() as m:
            m.post(f"{MADE}/privacy/restore", payload={"restored_text": "email jane@example.com"})
            m.post(
                f"{MADE}/privacy/restore",
                payload={"restored_text": "sure, I'll email jane@example.com"},
            )
            f = make_filter()
            body = {
                "messages": [
                    {"role": "user", "content": "email [EMAIL_1]"},
                    {"role": "assistant", "content": "sure, I'll email [EMAIL_1]"},
                ]
            }

            result = await f.outlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "email jane@example.com"
            assert result["messages"][1]["content"] == "sure, I'll email jane@example.com"

    asyncio.run(run())


def test_outlet_leaves_message_unchanged_when_made_unreachable():
    async def run():
        with aioresponses() as m:
            m.post(f"{MADE}/privacy/restore", exception=Exception("connection refused"))
            f = make_filter()
            body = {"messages": [{"role": "assistant", "content": "sure, I'll email [EMAIL_1]"}]}

            result = await f.outlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "sure, I'll email [EMAIL_1]"

    asyncio.run(run())


def test_redact_and_classify_use_the_requesting_users_id_as_org_id():
    async def run():
        with aioresponses() as m:
            _classify(m, "confidential")
            _redact(m, "email [EMAIL_1]", 1)
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "email jane@example.com"}]}

            await f.inlet(body, __user__={"id": "user-42"})

            posted = [
                call.kwargs["json"]
                for calls in m.requests.values()
                for call in calls
            ]
            assert posted and all(p["org_id"] == "user-42" for p in posted)

    asyncio.run(run())
