from sqlmodel import Session, select

from storage.models import ScoreCacheRecord


def get_cached_score(session: Session, scenario_id: str, candidate_id: str) -> ScoreCacheRecord | None:
    statement = select(ScoreCacheRecord).where(
        ScoreCacheRecord.scenario_id == scenario_id,
        ScoreCacheRecord.candidate_id == candidate_id,
    )
    return session.exec(statement).first()


def put_score(
    session: Session,
    scenario_id: str,
    candidate_id: str,
    cost_usd: float,
    quality: float,
    latency_ms: float,
    business_risk: float,
    raw_response: str,
    judge_raw: str,
) -> ScoreCacheRecord:
    record = ScoreCacheRecord(
        scenario_id=scenario_id,
        candidate_id=candidate_id,
        cost_usd=cost_usd,
        quality=quality,
        latency_ms=latency_ms,
        business_risk=business_risk,
        raw_response=raw_response,
        judge_raw=judge_raw,
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return record
