from storage.db import get_session, make_engine
from storage.models import DecisionRecord


def test_decision_record_roundtrip(tmp_path):
    engine = make_engine(tmp_path / "test.db")

    with get_session(engine) as session:
        record = DecisionRecord(
            decision_kind="model_selection",
            request_json="{}",
            response_json="{}",
            policy_version="test-sha",
        )
        session.add(record)
        session.commit()
        session.refresh(record)
        record_id = record.id

    assert record_id is not None

    with get_session(engine) as session:
        fetched = session.get(DecisionRecord, record_id)
        assert fetched.decision_kind == "model_selection"
        assert fetched.policy_version == "test-sha"
