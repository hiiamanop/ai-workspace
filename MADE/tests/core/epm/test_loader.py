import pytest

from core.epm.loader import EpmValidationError, load_epm_manifest


def test_loads_valid_manifest(tmp_path):
    manifest_path = tmp_path / "epm.yaml"
    manifest_path.write_text(
        "version: 1\n"
        "objectives:\n"
        "  - name: cost\n"
        "    direction: minimize\n"
        "    weight: 0.6\n"
        "  - name: quality\n"
        "    direction: maximize\n"
        "    weight: 0.4\n"
        "technique: topsis\n"
    )

    manifest = load_epm_manifest(manifest_path)

    assert manifest.version == 1
    assert manifest.technique == "topsis"
    assert [o.name for o in manifest.objectives] == ["cost", "quality"]


def test_rejects_weights_not_summing_to_one(tmp_path):
    manifest_path = tmp_path / "epm.yaml"
    manifest_path.write_text(
        "version: 1\n"
        "objectives:\n"
        "  - name: cost\n"
        "    direction: minimize\n"
        "    weight: 0.9\n"
        "technique: weighted_sum\n"
    )

    with pytest.raises(EpmValidationError, match="sum to"):
        load_epm_manifest(manifest_path)


def test_rejects_duplicate_objective_names(tmp_path):
    manifest_path = tmp_path / "epm.yaml"
    manifest_path.write_text(
        "version: 1\n"
        "objectives:\n"
        "  - name: cost\n"
        "    direction: minimize\n"
        "    weight: 0.5\n"
        "  - name: cost\n"
        "    direction: maximize\n"
        "    weight: 0.5\n"
        "technique: weighted_sum\n"
    )

    with pytest.raises(EpmValidationError, match="duplicate"):
        load_epm_manifest(manifest_path)


def test_rejects_unknown_technique(tmp_path):
    manifest_path = tmp_path / "epm.yaml"
    manifest_path.write_text(
        "version: 1\n"
        "objectives:\n"
        "  - name: cost\n"
        "    direction: minimize\n"
        "    weight: 1.0\n"
        "technique: pareto\n"
    )

    with pytest.raises(Exception):
        load_epm_manifest(manifest_path)
