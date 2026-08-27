"""
Open WebUI inlet/outlet Filter that redacts confidential content before it
reaches an external model, and restores it in the response before it's
shown or saved. Same source-of-truth pattern as made_routing.py —
src/openwebui-provision-redaction.ts installs this exact content into Open
WebUI's own database. Editing the Function directly through its admin UI
will be silently overwritten the next time the provisioning script runs.

Cooperates with made_routing.py rather than replacing its hardcoded
"internal" classification. inlet() asks MADE's POST /privacy/classify to
rate the combined user text (public/internal/confidential/restricted), then:
  - always runs POST /privacy/redact on each user message (a stray PII span
    should be pseudonymised regardless of the overall classification), and
  - when the classification is confidential/restricted, sets
    body["_privacy"] = {"data_classification": <that>, "redacted": <bool>}
    EVEN IF nothing was redactable — sensitive prose with no detectable PII
    still must not reach an external vendor unredacted. made_routing.py
    reads _privacy (falling back to "internal"/not-redacted when absent, so
    it still works standalone if this Filter isn't installed) and forwards
    it to MADE's /decide — that's what lets external_vendor.rego /
    restricted.rego actually engage.

This Filter MUST run before made_routing.py for that signal to exist in
time, which is why Valves.priority defaults to -10 (Open WebUI sorts
filters ascending by priority, made_routing.py defaults to 0).

If /privacy/classify is unreachable, inlet() degrades to redact-only (the
pre-classifier behaviour): whatever /privacy/redact removes still sets
_privacy confidential, anything it can't see slips through — no worse than
before this endpoint existed.

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
        self._classify_cache: dict[tuple[str, str], str] = {}

    async def inlet(self, body: dict, __user__: dict = None) -> dict:
        org_id = (__user__ or {}).get("id") or "anonymous"

        user_messages = [
            m for m in body.get("messages", [])
            if m.get("role") == "user" and isinstance(m.get("content"), str) and m.get("content")
        ]
        if not user_messages:
            return body

        combined = "\n".join(m["content"] for m in user_messages)
        try:
            classification = await self._classify(org_id, combined)
        except Exception as err:
            print(f"confidential redaction: classify failed: {err}, treating as internal")
            classification = "internal"

        # Only redact confidential/restricted messages. Redaction (regex +
        # NER) is imperfect and over-eager on casual text — running it on an
        # ordinary "internal" query mangles it ("ayam goreng" -> [PERSON_1])
        # for no protective benefit, since "internal" is allowed to reach the
        # vendor anyway.
        if classification not in ("confidential", "restricted"):
            return body

        total_redactions = 0
        for message in user_messages:
            try:
                redacted_text, count = await self._redact(org_id, message["content"])
            except Exception as err:
                print(f"confidential redaction: redact failed: {err}, leaving message as-is")
                continue
            if count > 0:
                message["content"] = redacted_text
                total_redactions += count

        body["_privacy"] = {"data_classification": classification, "redacted": total_redactions > 0}

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

    async def _classify(self, org_id: str, text: str) -> str:
        cache_key = (org_id, text)
        cached = self._classify_cache.get(cache_key)
        if cached is not None:
            return cached

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.valves.MADE_URL}/privacy/classify",
                json={"org_id": org_id, "text": text},
                timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS),
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()
                result = data["classification"]
                self._classify_cache[cache_key] = result
                return result

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
