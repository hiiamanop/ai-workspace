"""
Open WebUI inlet/outlet Filter that redacts confidential content before it
reaches an external model, and restores it in the response before it's
shown or saved. Same source-of-truth pattern as made_routing.py —
src/openwebui-provision-redaction.ts installs this exact content into Open
WebUI's own database. Editing the Function directly through its admin UI
will be silently overwritten the next time the provisioning script runs.

Cooperates with made_routing.py rather than replacing its hardcoded
"internal" classification: when this Filter's inlet() actually redacts
something, it sets body["_privacy"] = {"data_classification": "confidential",
"redacted": True} on the request. made_routing.py reads that (falling back
to "internal"/not-redacted when absent, so it still works standalone if
this Filter isn't installed) and forwards it to MADE's /decide — that's
what lets external_vendor.rego's deny rule actually engage. This Filter
MUST run before made_routing.py for that signal to exist in time, which is
why Valves.priority defaults to -10 (Open WebUI sorts filters ascending by
priority, made_routing.py defaults to 0).

org_id for MADE's per-org entity-mapping scope (see
core/privacy/pseudonymizer.py) is the requesting user's id (__user__.id) —
each user gets their own stable placeholder mapping, not one shared across
the whole deployment.
"""
import aiohttp
from pydantic import BaseModel


class Filter:
    class Valves(BaseModel):
        MADE_URL: str = "http://made:8000"
        REQUEST_TIMEOUT_SECONDS: float = 8.0
        priority: int = -10

    def __init__(self):
        self.valves = self.Valves()
        # ponytail: Open WebUI resends the whole message history every turn,
        # so without this cache every old message gets re-sent to MADE's
        # /privacy/redact and /privacy/restore (regex + spaCy NER) on every
        # single turn of a conversation. Plain dict, no eviction — Filter
        # instances are process-lifetime in Open WebUI, so this only grows
        # per unique (org_id, text) pair actually seen; switch to an LRU if
        # memory ever becomes a real concern.
        self._redact_cache: dict[tuple[str, str], tuple[str, int]] = {}
        self._restore_cache: dict[tuple[str, str], str] = {}

    async def inlet(self, body: dict, __user__: dict = None) -> dict:
        org_id = (__user__ or {}).get("id") or "anonymous"
        total_redactions = 0

        for message in body.get("messages", []):
            if message.get("role") != "user":
                continue
            content = message.get("content")
            if not isinstance(content, str) or not content:
                continue
            try:
                redacted_text, count = await self._redact(org_id, content)
            except Exception as err:
                print(f"confidential redaction: redact failed: {err}, leaving message as-is")
                continue
            if count > 0:
                message["content"] = redacted_text
                total_redactions += count

        if total_redactions > 0:
            body["_privacy"] = {"data_classification": "confidential", "redacted": True}

        return body

    async def outlet(self, body: dict, __user__: dict = None) -> dict:
        org_id = (__user__ or {}).get("id") or "anonymous"

        for message in body.get("messages", []):
            content = message.get("content")
            if not isinstance(content, str) or not content:
                continue
            try:
                message["content"] = await self._restore(org_id, content)
            except Exception as err:
                print(f"confidential redaction: restore failed: {err}, leaving message as-is")

        return body

    async def _redact(self, org_id: str, text: str) -> tuple[str, int]:
        cache_key = (org_id, text)
        cached = self._redact_cache.get(cache_key)
        if cached is not None:
            return cached

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.valves.MADE_URL}/privacy/redact",
                json={"org_id": org_id, "text": text},
                timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS),
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()
                result = (data["redacted_text"], data["redaction_count"])
                self._redact_cache[cache_key] = result
                return result

    async def _restore(self, org_id: str, text: str) -> str:
        cache_key = (org_id, text)
        cached = self._restore_cache.get(cache_key)
        if cached is not None:
            return cached

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.valves.MADE_URL}/privacy/restore",
                json={"org_id": org_id, "text": text},
                timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS),
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()
                result = data["restored_text"]
                self._restore_cache[cache_key] = result
                return result
