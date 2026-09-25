from types import SimpleNamespace

from observability import TurnTracker


class RecordingClient:
    """Capture emitted events so turn translation can be tested without Supabase."""

    def __init__(self) -> None:
        self.events = []

    def emit_nowait(self, event_type, **kwargs):
        self.events.append((event_type, kwargs))


def event(event_type, **values):
    values.setdefault("created_at", 100.0)
    return SimpleNamespace(type=event_type, **values)


def test_turn_tracker_records_one_exchange_in_order():
    client = RecordingClient()
    tracker = TurnTracker(client)

    tracker.on_user_state_changed(event("user_state_changed", old_state="listening", new_state="speaking"))
    tracker.on_user_state_changed(event("user_state_changed", old_state="speaking", new_state="listening"))
    tracker.on_user_transcript(
        event("user_input_transcribed", transcript="AA BB CC", is_final=True, language="en")
    )
    tracker.on_conversation_item(
        event(
            "conversation_item_added",
            item=SimpleNamespace(role="assistant", text_content="DD", metrics={}),
        )
    )
    tracker.on_agent_state_changed(event("agent_state_changed", old_state="thinking", new_state="speaking"))
    tracker.on_agent_state_changed(event("agent_state_changed", old_state="speaking", new_state="listening"))

    assert [name for name, _ in client.events] == [
        "turn.user_speech_stopped",
        "turn.transcript_completed",
        "turn.response_ready",
        "turn.agent_audio_started",
        "turn.completed",
    ]
    assert all(values["turn_number"] == 1 for _, values in client.events)


def test_component_metrics_create_a_completed_trace():
    client = RecordingClient()
    tracker = TurnTracker(client)
    tracker.current_turn_number = 2

    tracker.on_component_metrics(
        "llm",
        SimpleNamespace(timestamp=110.0, duration=0.8, cancelled=False),
    )

    name, values = client.events[0]
    assert name == "trace.llm"
    assert values["turn_number"] == 2
    assert values["payload"]["duration_ms"] == 800


def test_tool_lifecycle_records_success_duration():
    client = RecordingClient()
    tracker = TurnTracker(client)
    tracker.current_turn_number = 1

    tracker.on_tool_update(
        event(
            "tool_execution_updated",
            update=SimpleNamespace(
                type="tool_call_started",
                function_call=SimpleNamespace(
                    call_id="call-1",
                    name="lookup_weather",
                    arguments='{"city":"Istanbul"}',
                ),
            ),
        )
    )
    tracker.on_tool_update(
        event(
            "tool_execution_updated",
            created_at=102.5,
            update=SimpleNamespace(
                type="tool_call_ended",
                call_id="call-1",
                status="done",
                message="Sunny",
            ),
        )
    )

    assert [name for name, _ in client.events] == ["tool.started", "tool.succeeded"]
    assert client.events[1][1]["payload"]["duration_ms"] == 2500
