import asyncio
import copy
import os
import sys

from aioresponses import aioresponses

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from confidential_redaction import Filter  # noqa: E402


def make_filter():
    f = Filter()
    f.valves.MADE_URL = "http://made:8000"
    return f


def test_priority_defaults_to_run_before_made_routing():
    # made_routing.py's Valves has no explicit priority (defaults to 0 via
    # Open WebUI's getattr(valves, "priority", 0)) — this must sort earlier.
    f = make_filter()
    assert f.valves.priority < 0


def test_inlet_redacts_user_messages_and_sets_privacy_marker():
    async def run():
        with aioresponses() as m:
            m.post(
                "http://made:8000/privacy/redact",
                payload={"redacted_text": "email [EMAIL_1]", "redaction_count": 1},
            )
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "email jane@example.com"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "email [EMAIL_1]"
            assert result["_privacy"] == {"data_classification": "confidential", "redacted": True}

    asyncio.run(run())


def test_inlet_leaves_body_untouched_when_nothing_to_redact():
    async def run():
        with aioresponses() as m:
            m.post(
                "http://made:8000/privacy/redact",
                payload={"redacted_text": "hi there", "redaction_count": 0},
            )
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "hi there"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "hi there"
            assert "_privacy" not in result

    asyncio.run(run())


def test_inlet_only_redacts_user_role_messages():
    async def run():
        with aioresponses() as m:
            f = make_filter()
            body = {
                "messages": [
                    {"role": "system", "content": "you are helpful"},
                    {"role": "assistant", "content": "previous reply"},
                ]
            }

            result = await f.inlet(body, __user__={"id": "u1"})

            # No /privacy/redact call should have been made — nothing to assert
            # via aioresponses since none was registered; a call would raise.
            assert result["messages"][0]["content"] == "you are helpful"
            assert result["messages"][1]["content"] == "previous reply"

    asyncio.run(run())


def test_inlet_leaves_body_untouched_when_made_unreachable():
    async def run():
        with aioresponses() as m:
            m.post("http://made:8000/privacy/redact", exception=Exception("connection refused"))
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "email jane@example.com"}]}

            result = await f.inlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "email jane@example.com"
            assert "_privacy" not in result

    asyncio.run(run())


def test_outlet_restores_placeholders_in_all_messages():
    async def run():
        with aioresponses() as m:
            m.post(
                "http://made:8000/privacy/restore",
                payload={"restored_text": "email jane@example.com"},
            )
            m.post(
                "http://made:8000/privacy/restore",
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
            m.post("http://made:8000/privacy/restore", exception=Exception("connection refused"))
            f = make_filter()
            body = {"messages": [{"role": "assistant", "content": "sure, I'll email [EMAIL_1]"}]}

            result = await f.outlet(body, __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "sure, I'll email [EMAIL_1]"

    asyncio.run(run())


def test_inlet_does_not_re_call_made_for_a_message_seen_before():
    async def run():
        with aioresponses() as m:
            m.post(
                "http://made:8000/privacy/redact",
                payload={"redacted_text": "email [EMAIL_1]", "redaction_count": 1},
            )
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "email jane@example.com"}]}

            await f.inlet(copy.deepcopy(body), __user__={"id": "u1"})
            # Only one /privacy/redact response was registered above; a second
            # HTTP call for the same (org_id, text) would raise since
            # aioresponses has nothing left queued for it.
            result = await f.inlet(copy.deepcopy(body), __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "email [EMAIL_1]"

    asyncio.run(run())


def test_outlet_does_not_re_call_made_for_a_message_seen_before():
    async def run():
        with aioresponses() as m:
            m.post(
                "http://made:8000/privacy/restore",
                payload={"restored_text": "email jane@example.com"},
            )
            f = make_filter()
            body = {"messages": [{"role": "assistant", "content": "email [EMAIL_1]"}]}

            await f.outlet(copy.deepcopy(body), __user__={"id": "u1"})
            result = await f.outlet(copy.deepcopy(body), __user__={"id": "u1"})

            assert result["messages"][0]["content"] == "email jane@example.com"

    asyncio.run(run())


def test_redact_and_restore_use_the_requesting_users_id_as_org_id():
    async def run():
        with aioresponses() as m:
            m.post(
                "http://made:8000/privacy/redact",
                payload={"redacted_text": "email [EMAIL_1]", "redaction_count": 1},
            )
            f = make_filter()
            body = {"messages": [{"role": "user", "content": "email jane@example.com"}]}

            await f.inlet(body, __user__={"id": "user-42"})

            posted = list(m.requests.values())[0][0].kwargs["json"]
            assert posted["org_id"] == "user-42"

    asyncio.run(run())
