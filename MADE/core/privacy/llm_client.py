"""Cheap-LLM tie-break for data-classification, used only when the
classifier's heuristic layer is inconclusive.

Never raises: any failure (no key, timeout, HTTP error, unparseable reply)
returns None, and the caller falls back to a conservative default. Blocking
every chat because a classifier LLM is down would be worse than the
occasional mis-classification the heuristic already guards against.
"""
import os

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
    timeout = float(os.environ.get("MADE_CLASSIFIER_TIMEOUT", "6"))

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
                "max_tokens": 4,
            },
            timeout=timeout,
        )
        if response.status_code != 200:
            return None
        reply = response.json()["choices"][0]["message"]["content"].strip().lower()
    except (httpx.HTTPError, KeyError, ValueError):
        return None

    # Tolerate trailing punctuation / stray tokens — take the first enum word.
    for token in reply.replace(".", " ").split():
        if token in _ENUM:
            return token
    return None
