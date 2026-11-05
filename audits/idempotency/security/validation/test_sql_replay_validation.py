"""Independent replay assertions against DB team's disposable migrated cluster.

Uses its fixture adapter only; assertions are independent of its test assertions.
"""
import importlib.util
from pathlib import Path

import pytest

path = Path(__file__).resolve().parents[2] / "database/test_database_idempotency.py"
spec = importlib.util.spec_from_file_location("database_fixture", path)
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)


@pytest.mark.asyncio
async def test_real_sql_reused_key_changed_tool_and_arguments_rejected():
    sid = db.seed()
    backend = db.ActualDatabase(sid).backend()
    first = await backend.execute("request_callback", db.CALLBACK, "collision")
    second = await backend.execute("verify_identity", {
        "date_of_birth": "1900-01-01", "postal_code": "00000"}, "collision")
    assert first["code"] == "CALLBACK_REQUESTED"
    assert second["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert second["tool_name"] == "verify_identity"
    assert db.count("collection_operations", sid) == 1
    assert db.count("follow_up_requests", sid) == 1
    await backend.close()


@pytest.mark.asyncio
async def test_real_sql_identical_request_ids_in_separate_sessions_do_not_collide():
    sid_a, sid_b = db.seed(), db.seed()
    backends = [db.ActualDatabase(sid).backend() for sid in (sid_a, sid_b)]
    results = [await backend.execute("request_callback", db.CALLBACK, "shared-key") for backend in backends]
    assert results[0]["code"] == results[1]["code"] == "CALLBACK_REQUESTED"
    assert results[0]["data"] != results[1]["data"]
    assert db.count("follow_up_requests", sid_a) == db.count("follow_up_requests", sid_b) == 1
    for backend in backends:
        await backend.close()


@pytest.mark.asyncio
async def test_real_sql_prior_success_replays_after_session_closed_without_new_effect():
    sid = db.seed()
    backend = db.ActualDatabase(sid).backend()
    first = await backend.execute("request_callback", db.CALLBACK, "closed-replay")
    db.sql(f"UPDATE sessions SET status='completed' WHERE id={db.quoted(sid)}")
    replay = await backend.execute("request_callback", db.CALLBACK, "closed-replay")
    assert replay == first
    fresh = await backend.execute("request_callback", db.CALLBACK, "fresh-after-close")
    assert fresh["code"] == "SESSION_NOT_ACTIVE"
    assert db.count("follow_up_requests", sid) == 1
    await backend.close()
