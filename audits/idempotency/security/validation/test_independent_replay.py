"""Independent adversarial probes; no external network or product writes.

Run from Livekit-Agents:
  uv run pytest ../audits/idempotency/security/validation/test_independent_replay.py -q

The transport models only SQL's receipt lookup, not SQL concurrency/permissions.
"""

import json
import sys
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "Livekit-Agents/src"))
from collection_backend import CollectionBackend
from collection_agent import CollectionTools


class ReceiptTransport:
    def __init__(self):
        self.results = {}
        self.states = {}
        self.arguments = {}
        self.tools = {}
        self.commits = []

    def handle(self, request):
        body = json.loads(request.content)
        key = (body["p_session_id"], body["p_request_id"])
        state = self.states.get(key[0], {})
        if request.url.path.endswith("collection_snapshot"):
            result = self.results.get(key)
            if result is not None and (self.arguments.get(key) != body.get("p_arguments") or self.tools.get(key) != body.get("p_tool_name")):
                result = {"tool_name": body.get("p_tool_name"), "status":"rejected", "code":"IDEMPOTENCY_KEY_REUSED", "verified_user": bool(state.get("verified")), "data":{}}
            return httpx.Response(200, json={
                "state": deepcopy(state), "version": len(self.commits),
                "result": result, "session_status": "active",
                "customer": {"updated_at": "2026-11-04T00:00:00+00:00"},
                "now": "2026-11-04T00:00:00+00:00",
            })
        self.commits.append(body)
        self.results[key] = body["p_result"]
        self.arguments[key] = body["p_arguments"]
        self.tools[key] = body["p_result"]["tool_name"]
        self.states[key[0]] = body["p_state"]
        return httpx.Response(200, json={"result": body["p_result"]})

    def backend(self, session="session-A"):
        return CollectionBackend(session, "http://isolated", "fixture", client=httpx.AsyncClient(
            base_url="http://isolated/", transport=httpx.MockTransport(self.handle)))


@pytest.mark.asyncio
async def test_changed_payload_under_same_key_rejected_without_commit():
    transport = ReceiptTransport()
    saved = {"tool_name": "request_callback", "status": "success", "code": "CALLBACK_REQUESTED",
             "verified_user": False, "data": {"callback_at": "2026-11-05T12:00:00Z"}}
    transport.results[("session-A", "reused-id")] = saved
    backend = transport.backend()
    result = await backend.execute("request_callback", {"callback_at": "2026-11-06T12:00:00Z"}, "reused-id")
    assert result["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert transport.commits == []
    await backend.close()


@pytest.mark.asyncio
async def test_changed_tool_under_same_key_rejected_without_leaking_receipt():
    transport = ReceiptTransport()
    saved = {"tool_name": "verify_identity", "status": "success", "code": "IDENTITY_VERIFIED",
             "verified_user": True, "data": {"account": {"balance_cents": 100000}}}
    transport.results[("session-A", "reused-id")] = saved
    backend = transport.backend()
    result = await backend.execute("request_callback", {"callback_at": "2026-11-05T12:00:00Z"}, "reused-id")
    assert result["tool_name"] == "request_callback"
    assert result["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert result["verified_user"] is False
    assert backend.verified is False  # Current snapshot and historical result can differ.
    assert transport.commits == []
    await backend.close()


@pytest.mark.asyncio
async def test_same_key_does_not_retrieve_other_session_receipt():
    transport = ReceiptTransport()
    transport.results[("session-A", "shared-id")] = {"secret": "A only"}
    backend = transport.backend("session-B")
    assert (await backend.snapshot("shared-id"))["result"] is None
    await backend.close()


@pytest.mark.asyncio
async def test_wrapper_forwards_provider_call_id_and_runtime_session_owns_scope():
    backend = SimpleNamespace(state={}, execute=AsyncMock(return_value={"code": "fixture"}))
    tools = CollectionTools(backend, "en", {"request_callback"})
    context = SimpleNamespace(function_call=SimpleNamespace(call_id="provider-id"))
    await tools.invoke(context, "request_callback", {"callback_at": "2026-11-05T12:00:00Z"})
    await tools.invoke(context, "request_callback", {"callback_at": "2026-11-06T12:00:00Z"})
    assert [c.args[2] for c in backend.execute.await_args_list] == ["provider-id", "provider-id"]
    assert backend.execute.await_args_list[0].args[1] != backend.execute.await_args_list[1].args[1]
    assert backend.execute.await_args_list[0].kwargs["user_turn_id"] is None
    # Callback transition rejects effects until a real user message is observed.


def test_application_consumes_session_idempotency_header():
    source = (REPO / "supabase/functions/livekit-session/index.ts").read_text()
    assert 'rpc("session_start_reserve"' in source
    assert "idempotency-key" in source.lower()
    # Source evidence only. Executable handler replay belongs to the lead's suite.
