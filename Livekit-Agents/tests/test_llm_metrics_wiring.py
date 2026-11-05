"""Real SDK stream must deliver provider metrics through production wiring."""

from livekit.agents import AgentSession
from test_collection_runtime import ScriptedLLM
from test_observability import RecordingClient

from agent import register_component_metrics_handlers
from collection_agent import ConfiguredAssistant
from observability import TurnTracker


async def test_configured_llm_stream_produces_trace_without_model_service():
    model = ScriptedLLM(["Hello."])
    recorder = RecordingClient()
    tracker = TurnTracker(recorder)
    async with AgentSession(llm=model) as session:
        register_component_metrics_handlers(session, tracker)
        await session.start(ConfiguredAssistant(instructions="Be concise."))
        await session.run(user_input="Hello")
    metrics = [values for name, values in recorder.events if name == "trace.llm"]
    assert len(metrics) == 1
    assert metrics[0]["payload"]["status"] == "completed"
    assert metrics[0]["payload"]["metadata"]["type"] == "llm_metrics"
