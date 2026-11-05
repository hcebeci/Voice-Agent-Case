"""Simulation startup cannot create a production database/telemetry transport."""

import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import agent


async def test_simulation_uses_only_seeded_backend_even_with_production_env(
    monkeypatch,
):
    scenario = {
        "evaluation": True,
        "id": "synthetic-case",
        "customer": {"is_test_record": True},
        "configuration": {
            "instructions": "Use scenario instructions.",
            "language": "tr",
            "model": "test-model",
            "enabled_tools": ["verify_identity"],
        },
    }
    backend = SimpleNamespace(
        startup_snapshot=AsyncMock(return_value={"session_status": "active"}),
        close=AsyncMock(),
    )
    store = SimpleNamespace(scenario=scenario)
    monkeypatch.setitem(
        sys.modules,
        "evaluation",
        SimpleNamespace(make_evaluation_backend=lambda data: (backend, store)),
    )
    monkeypatch.setenv("SUPABASE_URL", "https://production.invalid")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "production-secret")

    def forbidden(*args, **kwargs):
        raise AssertionError("simulation attempted production transport")

    monkeypatch.setattr(agent, "ObservabilityClient", forbidden)
    monkeypatch.setattr(agent, "CollectionBackend", forbidden)
    for name in ("LLM", "STT", "TTS", "TurnDetector"):
        monkeypatch.setattr(agent.inference, name, lambda **kwargs: None)
    captured = {}

    class Session:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.stt = self.llm = self.tts = None

        def on(self, name):
            return lambda callback: callback

        async def start(self, **kwargs):
            captured["assistant"] = kwargs["agent"]

    monkeypatch.setattr(agent, "AgentSession", Session)
    ctx = SimpleNamespace(
        simulation_context=lambda: SimpleNamespace(
            userdata=lambda: scenario, simulation_mode=1
        ),
        job=SimpleNamespace(metadata=""),
        room=SimpleNamespace(name="simulation-room"),
        add_shutdown_callback=lambda callback: None,
        connect=AsyncMock(),
    )
    await agent.my_agent(ctx)
    assert captured["userdata"]["evaluation_store"] is store
    assert captured["userdata"]["evaluation_scenario"] is scenario
    assert "Use scenario instructions." in captured["assistant"].instructions
    assert "Turkish" in captured["assistant"].instructions
    assert captured["assistant"].collection_tools.backend is backend
    assert captured["assistant"].collection_tools.enabled_tools == {"verify_identity"}
    ctx.connect.assert_awaited_once()
