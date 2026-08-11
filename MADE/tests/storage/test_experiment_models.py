from storage.db import get_session, make_engine
from storage.models import ExperimentResult, ExperimentRun, ScoreCacheRecord


def test_score_cache_record_roundtrip_with_composite_key(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        session.add(ScoreCacheRecord(
            scenario_id="s-001", candidate_id="deepseek-v4-flash",
            cost_usd=0.002, quality=0.8, latency_ms=450.0, business_risk=0.25,
            raw_response="hello world", judge_raw="8",
        ))
        session.commit()

    with get_session(engine) as session:
        fetched = session.get(ScoreCacheRecord, ("s-001", "deepseek-v4-flash"))
        assert fetched.cost_usd == 0.002
        assert fetched.quality == 0.8


def test_experiment_run_and_result_roundtrip(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        run = ExperimentRun(baseline="made", scenario_dataset_version="v1")
        session.add(run)
        session.commit()
        session.refresh(run)
        run_id = run.id

        session.add(ExperimentResult(
            run_id=run_id, scenario_id="s-001", selected_candidate_id="deepseek-v4-flash",
            policy_violation=False, cost_usd=0.002, quality_score=0.8, latency_ms=450.0, status="ok",
        ))
        session.commit()

    with get_session(engine) as session:
        fetched_run = session.get(ExperimentRun, run_id)
        assert fetched_run.baseline == "made"
