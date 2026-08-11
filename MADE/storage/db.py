from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine


def make_engine(db_path: Path):
    engine = create_engine(f"sqlite:///{db_path}")
    SQLModel.metadata.create_all(engine)
    return engine


def get_session(engine) -> Session:
    return Session(engine)
