"""Provider-backed ambiguity resolver for privacy redaction.

The provider only proposes exact spans. MADE validates every span against the
original text and remains responsible for creating encrypted placeholders.
"""
import json
import os
import re

import httpx

from core.privacy.detectors import Span


SYSTEM_PROMPT = """Identify privacy-sensitive entities in the user text.
Return JSON only: {\"entities\":[{\"text\":\"exact substring\",\"type\":\"PERSON|ORG|GPE|EMAIL|PHONE|ID_NUMBER|CARD_NUMBER|SECRET\",\"redact\":true|false}]}.
Redact real personal data and secrets. Do not redact product names, model codes,
apps, fictional characters, brands, or technical terms (for example iPad Gen 11,
A16, HDMI, Google Ads, Figma, or Naruto). The text field must be copied exactly.
"""


def detect_with_provider(text: str) -> list[Span]:
    if os.environ.get("REDACTION_LLM_ENABLED", "false").lower() != "true":
        return []
    base_url = os.environ.get("OMNIROUTER_BASE_URL", "http://host.docker.internal:20128/v1").rstrip("/")
    api_key = os.environ.get("OMNIROUTER_API_KEY", "")
    if not api_key:
        return []
    payload = {
        "model": os.environ.get("REDACTION_LLM_MODEL", "auto"),
        "temperature": 0,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": text}],
        "response_format": {"type": "json_object"},
    }
    try:
        response = httpx.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=float(os.environ.get("REDACTION_LLM_TIMEOUT_SECONDS", "20")),
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.I)
        entities = json.loads(content).get("entities", [])
    except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return []

    spans: list[Span] = []
    for entity in entities if isinstance(entities, list) else []:
        if not isinstance(entity, dict) or entity.get("redact") is not True:
            continue
        value = entity.get("text")
        entity_type = entity.get("type")
        if not isinstance(value, str) or not value or entity_type not in {"PERSON", "ORG", "GPE", "EMAIL", "PHONE", "ID_NUMBER", "CARD_NUMBER", "SECRET"}:
            continue
        start = text.find(value)
        if start < 0 or any(start < existing.end and existing.start < start + len(value) for existing in spans):
            continue
        spans.append(Span(start, start + len(value), entity_type, value))
    return sorted(spans, key=lambda span: span.start)
