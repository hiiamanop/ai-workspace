from pathlib import Path

import yaml


def load_candidates_config(path: Path) -> dict:
    raw = yaml.safe_load(path.read_text())
    models_by_id = {m["id"]: m for m in raw.get("models", [])}
    return {"models_by_id": models_by_id, "raw": raw}


def load_ahp_weights(path: Path) -> dict[str, float]:
    raw = yaml.safe_load(path.read_text())
    weights = raw["weights"]
    total = sum(weights.values())
    if abs(total - 1.0) > 0.01:
        raise ValueError(f"ahp weights in {path} must sum to ~1.0, got {total}")
    return weights
