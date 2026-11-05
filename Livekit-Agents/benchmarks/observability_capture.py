"""Offline capture latency: run with `uv run python benchmarks/observability_capture.py`.

Measures synchronous time spent on the voice event loop while persisting telemetry.
This is not a measurement of provider latency or end-to-end time to first audio.
The comparison reinstates the original capacity query in the same capture path;
both variants retain the current transactional triggers and FULL durability.
"""

import asyncio
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from observability import ObservabilityClient


class LegacyCapacityScan:
    """Substitute only the old linear capacity query for an isolated comparison."""

    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection.__enter__()

    def __exit__(self, *args):
        return self.connection.__exit__(*args)

    def execute(self, query, *args):
        if query == "select event_count,byte_count from outbox_usage where singleton=1":
            query = "select count(*), coalesce(sum(bytes),0) from events"
        return self.connection.execute(query, *args)


async def measure(backlog: int, *, legacy_scan=False, samples: int = 100) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        client = ObservabilityClient(
            "benchmark",
            "https://benchmark.invalid",
            "synthetic-secret",
            spool_dir=directory,
            client=httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(200))
            ),
        )
        # Seed outside the measured interval; no network task runs during capture.
        body = json.dumps({"payload": "x" * 2000})
        with client._db:
            client._db.executemany(
                "insert into events values(?,?,?,?,?)",
                ((f"seed-{i}", "seed", i, body, len(body)) for i in range(backlog)),
            )
        connection = client._db
        if legacy_scan:
            client._db = LegacyCapacityScan(connection)
        durations = []
        for _ in range(samples):
            started = time.perf_counter()
            accepted = client.emit_nowait(
                "turn.response_ready", payload={"transcript": "synthetic reply"}
            )
            durations.append((time.perf_counter() - started) * 1000)
            assert accepted
        client._db = connection
        # Avoid benchmarking delivery or leaving a pending sender behind.
        with client._db:
            client._db.execute("delete from events")
        await client.close()
        ordered = sorted(durations)
        return {
            "capacity_check": "legacy_scan" if legacy_scan else "maintained_totals",
            "backlog": backlog,
            "samples": samples,
            "median_ms": round(statistics.median(ordered), 3),
            "p95_ms": round(ordered[int((samples - 1) * 0.95)], 3),
            "max_ms": round(max(ordered), 3),
        }


async def main():
    results = [
        await measure(size, legacy_scan=legacy_scan)
        for size in (0, 5000, 9000)
        for legacy_scan in (True, False)
    ]
    print(json.dumps({"capture": results}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
