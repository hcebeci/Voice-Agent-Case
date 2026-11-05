import asyncio

import httpx
import pytest

from collection_backend import CollectionBackend


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "503"])
async def test_startup_recovers_transient_failure(failure):
    calls = []

    def handle(request):
        calls.append(request)
        if len(calls) == 1:
            if failure == "timeout":
                raise httpx.ReadTimeout("slow response", request=request)
            return httpx.Response(503)
        return httpx.Response(
            200, json={"state": {"verified": True}, "session_status": "active"}
        )

    async with httpx.AsyncClient(
        base_url="https://test/", transport=httpx.MockTransport(handle)
    ) as client:
        backend = CollectionBackend("session", "https://test", "secret", client=client)
        result = await backend.startup_snapshot()
        assert result["session_status"] == "active"
        assert backend.verified
        assert len(calls) == 2
        assert calls[0].content == calls[1].content
        assert calls[0].extensions["timeout"]["read"] == 10.0


@pytest.mark.asyncio
@pytest.mark.parametrize("status,attempts", [(401, 1), (403, 1), (503, 2)])
async def test_startup_retries_only_transient_errors(status, attempts):
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(status)

    async with httpx.AsyncClient(
        base_url="https://test/", transport=httpx.MockTransport(handle)
    ) as client:
        backend = CollectionBackend("session", "https://test", "secret", client=client)
        with pytest.raises(httpx.HTTPStatusError):
            await backend.startup_snapshot()
        assert len(calls) == attempts


@pytest.mark.asyncio
async def test_startup_has_total_deadline():
    async def handle(request):
        await asyncio.sleep(10)
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(
        base_url="https://test/", transport=httpx.MockTransport(handle)
    ) as client:
        backend = CollectionBackend("session", "https://test", "secret", client=client)
        with pytest.raises(asyncio.TimeoutError):
            await backend.startup_snapshot(timeout=0.01)
