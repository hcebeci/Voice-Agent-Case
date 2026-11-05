"""Offline delivery regressions; transport fixtures never contact Supabase."""

import asyncio
import json

import httpx

from observability import ObservabilityClient


async def test_outage_survives_restart_with_same_event_identity_and_synthetic_data(
    tmp_path,
):
    attempted = []

    def unavailable(request):
        attempted.append(json.loads(request.content))
        return httpx.Response(503)

    first = ObservabilityClient(
        "test-session",
        "https://test.invalid",
        "secret",
        spool_dir=tmp_path,
        client=httpx.AsyncClient(transport=httpx.MockTransport(unavailable)),
        shutdown_timeout=0.05,
        retry_interval=0.01,
    )
    first.emit_nowait(
        "tool.started",
        payload={"arguments": {"date_of_birth": "1988-04-12", "postal_code": "34000"}},
    )
    await first.close()
    assert first.pending_count == 1
    assert first.last_delivery_error is not None
    assert attempted
    saved_id = attempted[0]["event_id"]
    delivered = []

    def available(request):
        delivered.append(json.loads(request.content))
        return httpx.Response(200)

    second = ObservabilityClient(
        "new-worker-session",
        "https://test.invalid",
        "secret",
        spool_dir=tmp_path,
        client=httpx.AsyncClient(transport=httpx.MockTransport(available)),
        shutdown_timeout=1,
    )
    await second.close()
    assert second.pending_count == 0
    assert len(delivered) == 1
    assert delivered[0]["event_id"] == saved_id
    assert delivered[0]["session_id"] == "test-session"
    assert delivered[0]["payload"]["arguments"]["date_of_birth"] == "1988-04-12"
    assert "secret" not in next(tmp_path.glob("*.sqlite3")).read_bytes().decode(
        errors="ignore"
    )


async def test_successful_delivery_acknowledges_and_sequence_survives_restart(tmp_path):
    delivered = []

    def receive(request):
        delivered.append(json.loads(request.content))
        return httpx.Response(200)

    for _ in range(2):
        client = ObservabilityClient(
            "same-session",
            "https://test.invalid",
            "secret",
            spool_dir=tmp_path,
            client=httpx.AsyncClient(transport=httpx.MockTransport(receive)),
        )
        client.emit_nowait("turn.completed")
        await client.close()
        assert client.pending_count == 0
    assert [body["sequence_number"] for body in delivered] == [1, 2]
    assert delivered[0]["event_id"] != delivered[1]["event_id"]


async def test_shutdown_is_bounded_when_transport_never_completes(tmp_path):
    started = asyncio.Event()

    async def hang(request):
        started.set()
        await asyncio.Event().wait()

    client = ObservabilityClient(
        "session",
        "https://test.invalid",
        "secret",
        spool_dir=tmp_path,
        client=httpx.AsyncClient(transport=httpx.MockTransport(hang)),
        shutdown_timeout=0.02,
    )
    client.emit_nowait("turn.completed")
    await asyncio.wait_for(started.wait(), timeout=1)
    await asyncio.wait_for(client.close(), timeout=0.3)
    assert client.pending_count == 1
    assert client._sender_task.done()
    await client.close()


async def test_full_outbox_rejects_new_event_explicitly_without_dropping_old_one(
    tmp_path, caplog
):
    async def hang(request):
        await asyncio.Event().wait()

    client = ObservabilityClient(
        "session",
        "https://test.invalid",
        "secret",
        spool_dir=tmp_path,
        client=httpx.AsyncClient(transport=httpx.MockTransport(hang)),
        shutdown_timeout=0.01,
        max_events=1,
    )
    assert client.emit_nowait("first") is True
    assert client.emit_nowait("second") is False
    assert client.dropped_events == 1
    assert client.pending_count == 1
    assert "outbox full" in caplog.text.lower()
    await client.close()


async def test_outbox_payload_limit_is_enforced(tmp_path):
    client = ObservabilityClient(
        "session",
        "https://test.invalid",
        "secret",
        spool_dir=tmp_path,
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200))
        ),
        max_bytes=100,
    )
    assert client.emit_nowait("event", payload={"large": "x" * 1000}) is False
    assert client.pending_count == 0
    await client.close()


async def test_committed_event_survives_abrupt_process_exit(tmp_path):
    import subprocess
    import sys

    script = """
import asyncio
import os
import sys
import httpx
from observability import ObservabilityClient

async def main():
    client = ObservabilityClient(
        'crashed-session', 'https://test.invalid', 'not-persisted-secret',
        spool_dir=sys.argv[1],
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200))),
    )
    assert client.emit_nowait('turn.transcript_completed', payload={'transcript': 'My postal code is 34000.'})
    os._exit(0)

asyncio.run(main())
"""
    # No network path exists; the process exits before its sender gets a turn.
    result = await asyncio.to_thread(
        subprocess.run,
        [sys.executable, "-c", script, str(tmp_path)],
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr.decode()
    recovered = []

    def receive(request):
        recovered.append(json.loads(request.content))
        return httpx.Response(200)

    client = ObservabilityClient(
        "replacement-session",
        "https://test.invalid",
        "secret",
        spool_dir=tmp_path,
        client=httpx.AsyncClient(transport=httpx.MockTransport(receive)),
    )
    await client.close()
    assert client.pending_count == 0
    assert len(recovered) == 1
    assert recovered[0]["session_id"] == "crashed-session"
    assert recovered[0]["payload"]["transcript"] == "My postal code is 34000."
