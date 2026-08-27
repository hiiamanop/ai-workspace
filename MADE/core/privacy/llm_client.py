"""Cheap-LLM tie-break for data-classification, used only when the
classifier's heuristic layer is inconclusive.

Never raises: any failure (no key, timeout, HTTP error, unparseable reply)
returns None, and the caller falls back to a conservative default. Blocking
every chat because a classifier LLM is down would be worse than the
occasional mis-classification the heuristic already guards against.
"""
import os
import re

import httpx

_ENUM = {"public", "internal", "confidential", "restricted"}

_SYSTEM_PROMPT = (
    "You classify the sensitivity of a text for data-loss-prevention. "
    "Reply with EXACTLY ONE word, one of: public, internal, confidential, restricted.\n"
    "- public: intended for outside publication (press releases, blog drafts, marketing).\n"
    "- internal: ordinary work content, no material harm if leaked.\n"
    "- confidential: material harm if leaked — finances, legal matters, HR/salary, "
    "unreleased plans, customer PII, contracts, anything marked internal-only or under NDA.\n"
    "- restricted: contains live credentials or secrets (API keys, passwords, private keys).\n"
    "When unsure between two levels, pick the more sensitive one."
)


def classify(text: str) -> str | None:
    api_key = os.environ.get("MADE_CLASSIFIER_API_KEY")
    if not api_key:
        return None

    base_url = os.environ.get("MADE_CLASSIFIER_BASE_URL", "https://api.deepseek.com")
    model = os.environ.get("MADE_CLASSIFIER_MODEL", "deepseek-v4-flash")
    # Reasoning models (deepseek-v4-flash is one) spend their first output
    # tokens on hidden reasoning before emitting the answer — a small
    # max_tokens returns empty content, and the whole round trip runs longer.
    timeout = float(os.environ.get("MADE_CLASSIFIER_TIMEOUT", "20"))

    try:
        response = httpx.post(
            f"{base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": text[:4000]},
                ],
                "temperature": 0,
                "max_tokens": 400,
                # Some OpenAI-compatible gateways stream by default; force a
                # single JSON body so response.json() works.
                "stream": False,
            },
            timeout=timeout,
        )
        if response.status_code != 200:
            return None
        message = response.json()["choices"][0]["message"]
    except (httpx.HTTPError, KeyError, ValueError):
        return None

    content = (message.get("content") or "").strip().lower()
    if content in _ENUM:
        return content

    # Fall back to scanning content + any reasoning text for the LAST enum word
    # (a reasoning trace lands on its conclusion at the end).
    blob = f"{content} {(message.get('reasoning_content') or '').lower()}"
    found = [tok for tok in re.split(r"[^a-z]+", blob) if tok in _ENUM]
    return found[-1] if found else None
