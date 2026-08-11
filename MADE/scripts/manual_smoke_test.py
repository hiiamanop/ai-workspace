"""Manual smoke test: exercises POST /decide for model selection, tool
selection, and human-approval gating against a running MADE server.

Prerequisites:
  - OPA installed and on PATH
  - MADE server running: uvicorn api.main:app --reload

Run:
  python scripts/manual_smoke_test.py
"""
import sys
from pathlib import Path

import httpx
import yaml

BASE_URL = "http://127.0.0.1:8000"


def load_candidates() -> dict:
    path = Path(__file__).resolve().parent.parent / "config" / "candidates.yaml"
    return yaml.safe_load(path.read_text())


def run_case(name: str, payload: dict) -> None:
    response = httpx.post(f"{BASE_URL}/decide", json=payload, timeout=10)
    response.raise_for_status()
    body = response.json()
    print(f"\n=== {name} ===")
    print(f"selected: {body['selected_candidate_id']}")
    print(f"requires_human_approval: {body['requires_human_approval']}")
    print(f"excluded: {body['excluded']}")


def main() -> int:
    candidates = load_candidates()

    run_case("model_selection (internal data)", {
        "task": {"type": "summarization", "data_classification": "internal"},
        "decision_kind": "model_selection",
        "candidates": candidates["models"],
    })

    run_case("tool_selection (public data)", {
        "task": {"type": "automation", "data_classification": "public"},
        "decision_kind": "tool_selection",
        "candidates": candidates["tools"],
    })

    run_case("human_approval gate (restricted contract_review)", {
        "task": {"type": "contract_review", "data_classification": "restricted"},
        "decision_kind": "model_selection",
        "candidates": candidates["models"],
    })

    return 0


if __name__ == "__main__":
    sys.exit(main())
