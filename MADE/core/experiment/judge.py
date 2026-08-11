import re
from typing import NamedTuple

from core.experiment.deepseek_client import DeepSeekError, complete

JUDGE_MODEL = "deepseek-v4-pro"


class JudgeResult(NamedTuple):
    score: float
    raw_text: str

_RUBRIC_PROMPT = """You are evaluating the quality of an AI assistant's response to a task.

Task prompt:
{prompt}

Response to evaluate:
{response_text}

Rate the response's quality on a scale from 0 to 10, where 0 is completely
unhelpful or incorrect and 10 is excellent, accurate, and complete.
Reply with ONLY the number, nothing else."""


def judge_quality(prompt: str, response_text: str) -> JudgeResult:
    judge_prompt = _RUBRIC_PROMPT.format(prompt=prompt, response_text=response_text)

    last_error: DeepSeekError | None = None
    for attempt in range(2):
        result = complete(JUDGE_MODEL, judge_prompt)
        stripped = result.text.strip()
        if attempt == 0:
            # Strict primary parse: the judge was instructed to reply with
            # ONLY the number. Anything else risks matching a stray digit
            # from restated rubric text (e.g. "0" from "0 to 10").
            match = re.fullmatch(r"\d+(\.\d+)?", stripped)
        else:
            # Retry fallback: be lenient in case the judge didn't follow
            # instructions but the right number is still present in the text.
            match = re.search(r"\d+(\.\d+)?", stripped)
        if match:
            score = float(match.group())
            if 0 <= score <= 10:
                return JudgeResult(score / 10.0, result.text)
            last_error = DeepSeekError(f"judge score out of range 0-10: {score}")
        else:
            last_error = DeepSeekError(f"could not parse judge score from: {result.text!r}")

    raise last_error
