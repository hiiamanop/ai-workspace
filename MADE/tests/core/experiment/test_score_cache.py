from core.experiment.score_cache import get_cached_score, put_score
from storage.db import get_session, make_engine


def test_put_then_get_returns_same_score(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        put_score(
            session, "s-001", "deepseek-v4-flash",
            cost_usd=0.002, quality=0.8, latency_ms=850.0, business_risk=0.25,
            raw_response="hello", judge_raw="8",
        )

    with get_session(engine) as session:
        cached = get_cached_score(session, "s-001", "deepseek-v4-flash")

    assert cached is not None
    assert cached.cost_usd == 0.002
    assert cached.quality == 0.8


def test_get_cached_score_returns_none_for_miss(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        cached = get_cached_score(session, "s-999", "unknown")

    assert cached is None
