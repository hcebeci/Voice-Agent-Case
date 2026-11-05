"""Capture complexity and durable capacity accounting, without live services."""

import json
import sqlite3

import httpx

from observability import ObservabilityClient


def make_client(tmp_path, **kwargs):
    return ObservabilityClient(
        "capture-session",
        "https://test.invalid",
        "secret",
        spool_dir=tmp_path,
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200))
        ),
        **kwargs,
    )


def capture_sql_steps(client):
    steps = 0

    def progress():
        nonlocal steps
        steps += 1
        return 0

    client._db.set_progress_handler(progress, 1)
    try:
        assert client.emit_nowait("turn.response_ready")
    finally:
        client._db.set_progress_handler(None, 0)
    return steps


async def test_capture_database_work_does_not_grow_with_outage_backlog(tmp_path):
    client = make_client(tmp_path)
    try:
        empty_steps = capture_sql_steps(client)
        with client._db:
            client._db.executemany(
                "insert into events values(?,?,?,?,?)",
                ((f"seed-{i}", "seed", i, "{}", 2) for i in range(2000)),
            )
        loaded_steps = capture_sql_steps(client)
        # Count SQLite VM work instead of using a timing assertion sensitive to CI.
        assert loaded_steps <= empty_steps + 100
    finally:
        with client._db:
            client._db.execute("delete from events")
        await client.close()


async def test_capacity_accounts_for_other_connections_and_acknowledgements(tmp_path):
    first = make_client(tmp_path, max_events=2)
    second = make_client(tmp_path, max_events=2)
    try:
        assert first.emit_nowait("first")
        assert second.emit_nowait("second")
        assert not first.emit_nowait("full")
        with second._db:
            second._db.execute("delete from events where sequence_number=1")
        assert first.emit_nowait("after_ack")
        assert second.pending_count == 2
        sequences = [
            row[0]
            for row in second._db.execute(
                "select sequence_number from events order by sequence_number"
            )
        ]
        assert sequences == [2, 3]
    finally:
        await first.close()
        await second.close()


async def test_existing_outbox_capacity_is_recovered_without_resetting_events(tmp_path):
    # Create a real pre-upgrade outbox, including its original event and sequence.
    client = make_client(tmp_path)
    path = client.spool_path
    await client.close()
    with sqlite3.connect(path) as db:
        for (name,) in db.execute(
            "select name from sqlite_master where type='trigger'"
        ):
            db.execute(f'DROP TRIGGER "{name}"')
        db.execute("drop table if exists outbox_usage")
        body = json.dumps({"event_id": "legacy", "event_type": "legacy"})
        db.execute(
            "insert into events values(?,?,?,?,?)",
            ("legacy", "capture-session", 7, body, len(body)),
        )
        db.execute("insert into sequences values('capture-session', 7)")
    upgraded = make_client(tmp_path, max_events=1)
    try:
        assert upgraded.pending_count == 1
        assert not upgraded.emit_nowait("full")
        with upgraded._db:
            upgraded._db.execute("delete from events where event_id='legacy'")
        assert upgraded.emit_nowait("new")
        row = upgraded._db.execute("select sequence_number from events").fetchone()
        assert row == (8,)
    finally:
        await upgraded.close()


async def test_capacity_byte_totals_follow_legacy_writes_and_deletes(tmp_path):
    client = make_client(tmp_path, max_bytes=1000)
    try:
        # A separate connection represents another worker sharing this endpoint.
        with sqlite3.connect(client.spool_path) as legacy:
            legacy.execute(
                "insert into events values(?,?,?,?,?)",
                ("other", "other-session", 1, "{}", 900),
            )
        assert not client.emit_nowait("exceeds_byte_limit")
        with sqlite3.connect(client.spool_path) as legacy:
            legacy.execute("delete from events where event_id='other'")
        assert client.emit_nowait("space_reclaimed")
        count, size = client._db.execute(
            "select count(*),sum(bytes) from events"
        ).fetchone()
        assert client._db.execute(
            "select event_count,byte_count from outbox_usage"
        ).fetchone() == (count, size)
    finally:
        await client.close()


async def test_failed_capture_rolls_back_event_sequence_and_capacity(tmp_path):
    client = make_client(tmp_path, max_events=1)
    try:
        client._db.executescript("""
            create trigger fail_sequence before insert on sequences
            begin select raise(abort, 'synthetic failure'); end;
        """)
        assert not client.emit_nowait("fails_after_event_insert")
        assert client.pending_count == 0
        assert client._db.execute("select count(*) from events").fetchone() == (0,)
        client._db.execute("drop trigger fail_sequence")
        assert client.emit_nowait("retry")
        assert client._db.execute("select sequence_number from events").fetchone() == (
            1,
        )
    finally:
        await client.close()
