"""Exercise actual SDK chat history and simulation verdict contracts offline."""

import json
from types import SimpleNamespace

import pytest
from livekit.agents import AgentSession
from livekit.agents.simulation import (
    SimulationContext,
    SimulationMode,
    SimulationVerdict,
)
from livekit.protocol import agent_simulation as proto
from test_collection import CUSTOMER
from test_collection_runtime import ScriptedLLM, call

import evaluation
from agent import EvaluationObservations, evaluation_mode, finish_evaluation_simulation
from collection_agent import ConfiguredAssistant
from observability import TurnTracker


def case():
    return {
        "evaluation": True,
        "id": "callback-regression",
        "name": "Callback regression",
        "now": "2026-09-27T12:00:00+00:00",
        "customer": dict(CUSTOMER, is_test_record=True),
        "configuration": {
            "instructions": "Verify the user.",
            "enabled_tools": ["verify_identity"],
            "model": "scripted-offline",
            "language": "en",
        },
        "expected_state": {"verified": True, "commitments": [], "callbacks": []},
    }


@pytest.mark.parametrize("correct_expected", [True, False])
@pytest.mark.parametrize(
    "mode", [SimulationMode.SIMULATION_MODE_TEXT, SimulationMode.SIMULATION_MODE_AUDIO]
)
async def test_real_sdk_callback_vetoes_wrong_state_and_retains_uncensored_evidence(
    tmp_path, monkeypatch, correct_expected, mode
):
    monkeypatch.setattr(evaluation, "DEFAULT_OUTPUT", tmp_path)
    scenario = case()
    if not correct_expected:
        scenario["expected_state"]["verified"] = False
    backend, store = evaluation.make_evaluation_backend(scenario)
    model = ScriptedLLM(
        [
            call("verify_identity", date_of_birth="1988-04-12", postal_code="34000"),
            "Your identity is verified.",
        ]
    )
    recorder = EvaluationObservations(store)
    tracker = TurnTracker(recorder)
    async with AgentSession(llm=model) as session:

        @session.on("tool_execution_updated")
        def tools(event):
            tracker.on_tool_update(event)

        await session.start(
            ConfiguredAssistant(
                backend=backend,
                instructions="Verify identity.",
                enabled_tools=["verify_identity"],
            )
        )
        await session.run(
            user_input="My date of birth is 1988-04-12 and postal code 34000."
        )
        assert backend.verified
        simulation = SimulationContext(
            proto.SimulationDispatch(
                simulation_run_id="offline-run",
                mode=mode,
                scenario=proto.Scenario(userdata=json.dumps(scenario)),
            ),
            SimpleNamespace(primary_session=session),
        )
        simulation._begin_finalize(
            simulator_verdict=SimulationVerdict(True, "Conversation passed"), run=None
        )
        session.userdata = {
            "evaluation_store": store,
            "evaluation_scenario": scenario,
            "evaluation_mode": evaluation_mode(simulation),
        }
        await finish_evaluation_simulation(simulation)
        assert (simulation.user_verdict is None) is correct_expected
    await backend.close()
    files = list(tmp_path.glob("*.json"))
    assert len(files) == 1
    report = json.loads(files[0].read_text())
    assert report["status"] == ("passed" if correct_expected else "failed")
    assert report["provenance"]["audio_tested"] is (
        mode == SimulationMode.SIMULATION_MODE_AUDIO
    )
    assert report["customer_snapshot"]["date_of_birth"] == "1988-04-12"
    assert any("34000" in message["content"] for message in report["transcript"])
    traces = report["actual_outcome"]["observations"]
    assert any(
        event["event_type"] == "tool.started"
        and event["payload"]["arguments"]["date_of_birth"] == "1988-04-12"
        for event in traces
    )


async def test_non_evaluation_session_does_not_create_evaluation_artifacts(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(evaluation, "DEFAULT_OUTPUT", tmp_path)
    async with AgentSession() as session:
        simulation = SimpleNamespace(
            job_context=SimpleNamespace(primary_session=session)
        )
        await evaluation.finish_simulation(simulation)
    assert list(tmp_path.iterdir()) == []


async def test_missing_primary_session_vetoes_simulation_without_raising():
    class JobWithoutSession:
        @property
        def primary_session(self):
            raise RuntimeError("No AgentSession was started for this job")

    simulation = SimulationContext(
        proto.SimulationDispatch(simulation_run_id="missing-session"),
        JobWithoutSession(),
    )
    simulation._begin_finalize(
        simulator_verdict=SimulationVerdict(True, "Simulator passed"), run=None
    )
    await evaluation.finish_simulation(simulation)
    assert simulation.user_verdict is not None
    assert simulation.user_verdict.success is False
