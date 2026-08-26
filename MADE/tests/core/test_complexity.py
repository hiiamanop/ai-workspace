from unittest.mock import patch

from core import complexity


def test_classify_maps_simple_label_to_low_complexity():
    with patch.object(complexity, "_get_pipeline") as get_pipeline:
        get_pipeline.return_value = lambda text: [{"label": "SIMPLE", "score": 0.99}]
        complexity._pipeline = None

        level, label, score = complexity.classify("hi")

    assert level == "low"
    assert label == "SIMPLE"
    assert score == 0.99


def test_classify_maps_complex_label_to_high_complexity():
    with patch.object(complexity, "_get_pipeline") as get_pipeline:
        get_pipeline.return_value = lambda text: [{"label": "COMPLEX", "score": 0.87}]
        complexity._pipeline = None

        level, label, score = complexity.classify("prove the halting problem is undecidable")

    assert level == "high"
    assert label == "COMPLEX"
    assert score == 0.87
