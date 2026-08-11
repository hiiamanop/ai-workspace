import pytest

from core.experiment.config_loader import load_ahp_weights, load_candidates_config


def test_load_candidates_config_indexes_models_by_id(tmp_path):
    config_path = tmp_path / "candidates.yaml"
    config_path.write_text(
        "models:\n"
        "  - id: deepseek-v4-flash\n"
        "    vendor: deepseek\n"
        "    kind: model\n"
        "    source: real\n"
        "    business_risk: 0.25\n"
        "tools: []\n"
    )

    config = load_candidates_config(config_path)

    assert "deepseek-v4-flash" in config["models_by_id"]
    assert config["models_by_id"]["deepseek-v4-flash"]["business_risk"] == 0.25


def test_load_ahp_weights_returns_dict(tmp_path):
    weights_path = tmp_path / "ahp_weights.yaml"
    weights_path.write_text(
        "version: 1\n"
        "weights:\n"
        "  cost: 0.25\n"
        "  quality: 0.5\n"
        "  latency: 0.15\n"
        "  business_risk: 0.1\n"
    )

    weights = load_ahp_weights(weights_path)

    assert weights == {"cost": 0.25, "quality": 0.5, "latency": 0.15, "business_risk": 0.1}


def test_load_ahp_weights_rejects_bad_sum(tmp_path):
    weights_path = tmp_path / "ahp_weights.yaml"
    weights_path.write_text(
        "version: 1\nweights:\n  cost: 0.9\n  quality: 0.0\n  latency: 0.0\n  business_risk: 0.0\n"
    )

    with pytest.raises(ValueError, match="sum to"):
        load_ahp_weights(weights_path)
