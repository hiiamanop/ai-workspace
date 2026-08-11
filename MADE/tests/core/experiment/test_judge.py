from unittest.mock import patch

import pytest

from core.experiment.deepseek_client import CompletionResult, DeepSeekError
from core.experiment.judge import judge_quality


def test_judge_quality_parses_score_and_normalizes():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.return_value = CompletionResult(text="7", cost_usd=0.001, latency_ms=100.0)
        result = judge_quality("summarize this", "a decent summary")

    assert result.score == pytest.approx(0.7)
    assert result.raw_text == "7"
    assert mock_complete.call_count == 1


def test_judge_quality_strict_first_attempt_rejects_noisy_text_then_retries_loosely():
    # The judge ignored the "reply with ONLY the number" instruction on the
    # first attempt (e.g. echoing "0 to 10" from the rubric); the strict
    # fullmatch on attempt 1 must reject it rather than grabbing a stray "0",
    # triggering a retry. On the retry, the loose fallback parses it.
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.side_effect = [
            CompletionResult(text="On a scale from 0 to 10, I'd say this is a 7", cost_usd=0.001, latency_ms=100.0),
            CompletionResult(text="Score: 8.5 out of 10", cost_usd=0.001, latency_ms=100.0),
        ]
        result = judge_quality("summarize this", "a good summary")

    assert result.score == pytest.approx(0.85)
    assert result.raw_text == "Score: 8.5 out of 10"
    assert mock_complete.call_count == 2


def test_judge_quality_strict_first_attempt_accepts_clean_numeric_reply():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.return_value = CompletionResult(text="  8.5  ", cost_usd=0.001, latency_ms=100.0)
        result = judge_quality("summarize this", "a good summary")

    assert result.score == pytest.approx(0.85)
    assert mock_complete.call_count == 1


def test_judge_quality_retries_once_on_unparseable_output_then_succeeds():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.side_effect = [
            CompletionResult(text="I cannot rate this.", cost_usd=0.001, latency_ms=100.0),
            CompletionResult(text="6", cost_usd=0.001, latency_ms=100.0),
        ]
        result = judge_quality("summarize this", "a summary")

    assert result.score == pytest.approx(0.6)
    assert mock_complete.call_count == 2


def test_judge_quality_raises_after_retry_exhausted():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.return_value = CompletionResult(text="unparseable", cost_usd=0.001, latency_ms=100.0)
        with pytest.raises(DeepSeekError, match="could not parse"):
            judge_quality("summarize this", "a summary")

    assert mock_complete.call_count == 2


def test_judge_quality_always_uses_v4_pro_regardless_of_candidate():
    with patch("core.experiment.judge.complete") as mock_complete:
        mock_complete.return_value = CompletionResult(text="9", cost_usd=0.001, latency_ms=100.0)
        judge_quality("prompt", "response from deepseek-v4-flash")

    called_model = mock_complete.call_args[0][0]
    assert called_model == "deepseek-v4-pro"
