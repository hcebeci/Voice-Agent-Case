"""Retry scheduling checks at the real backend/HTTP boundary, without network."""

import asyncio
import json
from copy import deepcopy
from unittest.mock import AsyncMock

import httpx
import pytest

from collection_backend import CollectionBackend


class RetryStore:
    """Synthetic durable store with injected transport failures."""

    def __init__(self, *, snapshot_status=None, commit_failure=None):
        self.snapshot_status = snapshot_status
        self.commit_failure = commit_failure
        self.state = {}
        self.result = None
        self.paths = []
        self.commits = 0

    def handle(self, request):
        self.paths.append(request.url.path)
        if request.url.path.endswith("collection_snapshot"):
            if self.snapshot_status:
                return httpx.Response(self.snapshot_status)
            return httpx.Response(
                200,
                json={
                    "state": deepcopy(self.state),
                    "version": self.commits,
                    "customer": {
                        "date_of_birth": "1980-01-01",
                        "postal_code": "11111",
                        "updated_at": "2026-09-27T00:00:00+00:00",
                    },
                    "session_status": "active",
                    "now": "2026-09-27T12:00:00+00:00",
                    "result": self.result,
                },
            )
        failure, self.commit_failure = self.commit_failure, None
        if failure == "before_write":
            raise httpx.ConnectError("connection unavailable", request=request)
        if isinstance(failure, int):
            return httpx.Response(failure)
        body = json.loads(request.content)
        if body["p_version"] != self.commits:
            return httpx.Response(200, json={"conflict": True})
        self.commits += 1
        self.state, self.result = body["p_state"], body["p_result"]
        if failure == "lost_response":
            raise httpx.ReadTimeout("response lost", request=request)
        return httpx.Response(200, json={"state": self.state, "result": self.result})

    def backend(self):
        return CollectionBackend(
            "synthetic-session",
            "https://test",
            "synthetic-secret",
            client=httpx.AsyncClient(
                base_url="https://test/", transport=httpx.MockTransport(self.handle)
            ),
        )


async def execute(backend):
    return await backend.execute(
        "verify_identity",
        {"date_of_birth": "1900-01-01", "postal_code": "00000"},
        "synthetic-request",
    )


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 422])
async def test_permanent_read_failure_returns_without_retries(status, monkeypatch):
    sleep = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", sleep)
    store = RetryStore(snapshot_status=status)
    backend = store.backend()
    try:
        result = await execute(backend)
        assert result["code"] == "SERVICE_UNAVAILABLE"
        assert len(store.paths) == 1
        assert store.commits == 0
        sleep.assert_not_awaited()
    finally:
        await backend.close()


async def test_lost_commit_response_reconciles_before_backoff(monkeypatch):
    sleep = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", sleep)
    store = RetryStore(commit_failure="lost_response")
    backend = store.backend()
    try:
        result = await execute(backend)
        assert result["code"] == "IDENTITY_NOT_VERIFIED"
        assert store.commits == 1
        assert store.state["attempts"] == 1
        assert len(store.paths) == 3
        sleep.assert_not_awaited()
    finally:
        await backend.close()


@pytest.mark.parametrize("failure", ["before_write", 503])
async def test_missing_receipt_retains_backoff_before_retry_write(failure, monkeypatch):
    sleep_paths = []

    async def sleep(delay):
        assert delay == 0.2
        sleep_paths.append(list(store.paths))

    monkeypatch.setattr(asyncio, "sleep", sleep)
    store = RetryStore(commit_failure=failure)
    backend = store.backend()
    try:
        result = await execute(backend)
        assert result["code"] == "IDENTITY_NOT_VERIFIED"
        assert store.commits == 1
        assert len(store.paths) == 5
        assert len(sleep_paths) == 1
        assert len(sleep_paths[0]) == 3
        assert sleep_paths[0][-1].endswith("collection_snapshot")
    finally:
        await backend.close()


async def test_retry_refreshes_state_after_backoff(monkeypatch):
    store = RetryStore(commit_failure="before_write")

    async def sleep(delay):
        # Another worker may commit while this worker is backing off.
        store.state["attempts"] = 2
        store.commits += 1

    monkeypatch.setattr(asyncio, "sleep", sleep)
    backend = store.backend()
    try:
        result = await execute(backend)
        assert result["code"] == "VERIFICATION_LOCKED"
        assert store.state["attempts"] == 3
        assert store.commits == 2
    finally:
        await backend.close()


@pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
async def test_transient_read_failure_still_retries_with_backoff(status, monkeypatch):
    sleep = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", sleep)
    store = RetryStore(snapshot_status=status)
    backend = store.backend()
    try:
        result = await execute(backend)
        assert result["code"] == "SERVICE_UNAVAILABLE"
        assert len(store.paths) == 3
        sleep.assert_awaited_once_with(0.2)
    finally:
        await backend.close()


async def test_permanent_commit_failure_never_reports_success(monkeypatch):
    sleep = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", sleep)
    store = RetryStore(commit_failure=403)
    backend = store.backend()
    try:
        result = await execute(backend)
        assert result["code"] == "OUTCOME_UNKNOWN"
        assert store.commits == 0
        assert len(store.paths) == 2
        sleep.assert_not_awaited()
    finally:
        await backend.close()
