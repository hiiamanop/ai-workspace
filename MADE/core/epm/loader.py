from pathlib import Path

import yaml
from pydantic import BaseModel, field_validator

from core.modm.models import Objective


class EpmManifest(BaseModel):
    version: int
    objectives: list[Objective]
    technique: str  # "topsis" | "weighted_sum"

    @field_validator("technique")
    @classmethod
    def validate_technique(cls, v: str) -> str:
        if v not in ("topsis", "weighted_sum"):
            raise ValueError(f"technique must be 'topsis' or 'weighted_sum', got {v!r}")
        return v


class EpmValidationError(ValueError):
    pass


def load_epm_manifest(path: Path) -> EpmManifest:
    raw = yaml.safe_load(path.read_text())
    manifest = EpmManifest.model_validate(raw)

    names = [o.name for o in manifest.objectives]
    if len(names) != len(set(names)):
        raise EpmValidationError(f"duplicate objective names in {path}: {names}")

    total_weight = sum(o.weight for o in manifest.objectives)
    if abs(total_weight - 1.0) > 0.01:
        raise EpmValidationError(
            f"objective weights in {path} must sum to ~1.0, got {total_weight}"
        )

    return manifest
