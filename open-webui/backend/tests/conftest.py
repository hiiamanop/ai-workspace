"""Test config for the policies backend (C1).

Must set DATABASE_URL / session-sharing BEFORE any open_webui import, since
open_webui.env computes engine bindings at import time.
"""

import asyncio
import os
import sys
from pathlib import Path

# open_webui is importable only with open-webui/backend on sys.path; conftest
# imports before any test module, so this covers every test file here.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ["DATABASE_URL"] = "sqlite:////tmp/owui-test-policies.db"
os.environ["DATABASE_ENABLE_SESSION_SHARING"] = "true"
os.environ["WEBUI_SECRET_KEY"] = "test-secret-key-for-policies-tests"  # env.py hard-exits without it
os.environ["VECTOR_DB"] = "none"  # skip chromadb import in config.py (not installed in test venv)

import pytest  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

TEST_DB_URL = "sqlite+aiosqlite:////tmp/owui-test-policies.db"


@pytest.fixture(scope="session", autouse=True)
def _create_policy_table():
    async def go():
        engine = create_async_engine(TEST_DB_URL)
        from open_webui.models.policies import Policy

        async with engine.begin() as conn:
            await conn.run_sync(Policy.__table__.create, checkfirst=True)
        await engine.dispose()

    asyncio.run(go())


@pytest.fixture(autouse=True)
def _clean_policies_before_test():
    async def clear():
        engine = create_async_engine(TEST_DB_URL)
        from open_webui.models.policies import Policy

        async with engine.begin() as conn:
            await conn.run_sync(lambda sync_conn: sync_conn.execute(Policy.__table__.delete()))
        await engine.dispose()

    asyncio.run(clear())
