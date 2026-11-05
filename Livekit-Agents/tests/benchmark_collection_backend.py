"""Synthetic backend timing: uv run python tests/benchmark_collection_backend.py.

No network or customer data. Each mock HTTP request costs --rtt-ms. Timings are
local sensitivity measurements, not estimates of production answer latency.
"""

import argparse
import asyncio
import importlib.util
import json
import logging
import statistics
import time

import httpx
from test_collection_backend_latency import RetryStore, execute

from collection_backend import CollectionBackend


async def benchmark(backend_type, iterations, rtt_ms):
    scenarios = {
        "normal": {},
        "permanent_read_403": {"snapshot_status": 403},
        "lost_commit_response": {"commit_failure": "lost_response"},
        "retry_write": {"commit_failure": "before_write"},
    }
    output = {"iterations": iterations, "simulated_request_rtt_ms": rtt_ms}
    for name, options in scenarios.items():
        samples, requests = [], []
        for _ in range(iterations):
            store = RetryStore(**options)

            async def handle(request, store=store):
                await asyncio.sleep(rtt_ms / 1000)
                return store.handle(request)

            async with httpx.AsyncClient(
                base_url="https://test/", transport=httpx.MockTransport(handle)
            ) as client:
                backend = backend_type(
                    "synthetic", "https://test", "secret", client=client
                )
                start = time.perf_counter()
                result = await execute(backend)
                samples.append((time.perf_counter() - start) * 1000)
                requests.append(len(store.paths))
                expected = (
                    "SERVICE_UNAVAILABLE"
                    if options.get("snapshot_status")
                    else "IDENTITY_NOT_VERIFIED"
                )
                assert result["code"] == expected
                assert store.commits == (0 if options.get("snapshot_status") else 1)
        output[name] = {
            "median_ms": round(statistics.median(samples), 2),
            "min_ms": round(min(samples), 2),
            "max_ms": round(max(samples), 2),
            "requests_per_execution": sorted(set(requests)),
        }
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--rtt-ms", type=float, default=20)
    parser.add_argument("--backend-file", help="Optional saved baseline backend module")
    args = parser.parse_args()
    if args.iterations < 1 or args.rtt_ms < 0:
        parser.error("iterations must be positive and RTT nonnegative")
    backend_type = CollectionBackend
    if args.backend_file:
        spec = importlib.util.spec_from_file_location(
            "baseline_backend", args.backend_file
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        backend_type = module.CollectionBackend
    logging.disable(logging.CRITICAL)
    print(
        json.dumps(
            asyncio.run(benchmark(backend_type, args.iterations, args.rtt_ms)), indent=2
        )
    )
