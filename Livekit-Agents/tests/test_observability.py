from dataclasses import dataclass
from types import SimpleNamespace

from observability import ObservabilityClient, TurnTracker, json_safe


class RecordingClient:
    """Capture emitted events so turn translation can be tested without Supabase."""

    def __init__(self) -> None:
        self.events = []

    def emit_nowait(self, event_type, **kwargs):
        self.events.append((event_type, kwargs))


def event(event_type, **values):
    values.setdefault("created_at", 100.0)
    return SimpleNamespace(type=event_type, **values)


@dataclass
class UsageEntry:
    """Represent one provider usage entry in the session usage payload."""

    type: str
    input_tokens: int
    output_tokens: int


@dataclass
class SessionUsage:
    """Represent LiveKit's dataclass-based cumulative usage object."""

    model_usage: list[UsageEntry]


def test_json_safe_keeps_session_usage_as_structured_data():
    payload = json_safe(SessionUsage([UsageEntry("llm_usage", 120, 30)]))

    assert payload == {
        "model_usage": [{"type": "llm_usage", "input_tokens": 120, "output_tokens": 30}],
    }


def test_session_usage_snapshot_is_emitted_only_when_values_change():
    client = object.__new__(ObservabilityClient)
    client._last_session_usage_signature = None
    emitted_events = []
    client.emit_nowait = lambda event_type, **kwargs: emitted_events.append((event_type, kwargs))

    first_payload = SessionUsage([UsageEntry("llm_usage", 120, 30)])
    assert client.emit_session_usage_if_changed(first_payload, occurred_at=100.0) is True
    assert client.emit_session_usage_if_changed(first_payload, occurred_at=101.0) is False
    assert len(emitted_events) == 1

    changed_payload = SessionUsage([UsageEntry("llm_usage", 121, 30)])
    assert client.emit_session_usage_if_changed(changed_payload, occurred_at=102.0) is True
    assert len(emitted_events) == 2


def test_turn_tracker_records_one_exchange_in_order():
    client = RecordingClient()
    tracker = TurnTracker(client)

    tracker.on_user_state_changed(event("user_state_changed", old_state="listening", new_state="speaking", created_at=100.0))
    tracker.on_user_state_changed(event("user_state_changed", old_state="speaking", new_state="listening", created_at=101.2))
    tracker.on_user_transcript(
        event("user_input_transcribed", transcript="AA BB CC", is_final=True, language="en")
    )
    tracker.on_conversation_item(
        event(
            "conversation_item_added",
            item=SimpleNamespace(role="assistant", text_content="DD", metrics={}),
        )
    )
    tracker.on_agent_state_changed(event("agent_state_changed", old_state="thinking", new_state="speaking", created_at=102.0))
    tracker.on_agent_state_changed(event("agent_state_changed", old_state="speaking", new_state="listening", created_at=103.4))

    assert [name for name, _ in client.events] == [
        "turn.user_speech_stopped",
        "trace.user_speaking",
        "turn.transcript_completed",
        "turn.response_ready",
        "turn.agent_audio_started",
        "trace.agent_speaking",
        "turn.completed",
    ]
    assert all(values["turn_number"] == 1 for _, values in client.events)
    assert client.events[1][1]["payload"]["duration_ms"] == 1200
    assert client.events[5][1]["payload"]["duration_ms"] == 1400


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


def test_session_close_finishes_an_agent_turn():
    client = RecordingClient()
    tracker = TurnTracker(client, current_turn_number=2, active_agent_speech_started_at=100.0)

    tracker.on_session_close(101.5)

    assert [name for name, _ in client.events] == ["trace.agent_speaking", "turn.completed"]
    assert client.events[0][1]["payload"]["duration_ms"] == 1500
    assert tracker.current_turn_number is None


def test_session_close_cancels_a_turn_without_agent_audio():
    client = RecordingClient()
    tracker = TurnTracker(client, current_turn_number=2)

    tracker.on_session_close(101.5)

    assert [name for name, _ in client.events] == ["turn.cancelled"]
    assert client.events[0][1]["turn_number"] == 2


def test_session_close_persists_user_speech_that_has_not_stopped_yet():
    client = RecordingClient()
    tracker = TurnTracker(client, current_turn_number=2, active_user_speech_started_at=100.0)

    tracker.on_session_close(101.5)

    assert [name for name, _ in client.events] == [
        "turn.user_speech_stopped",
        "trace.user_speaking",
        "turn.cancelled",
    ]
    assert client.events[1][1]["payload"]["duration_ms"] == 1500
    assert client.events[1][1]["payload"]["metadata"]["closed_with_session"] is True


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


def test_verification_arguments_redacted_and_structured_errors_mark_failed():
    client = RecordingClient()
    tracker = TurnTracker(client)
    tracker.on_tool_update(event('tool_execution_updated', update=SimpleNamespace(
        type='tool_call_started', function_call=SimpleNamespace(call_id='private-call',
        name='verify_identity', arguments='{"date_of_birth":"1988-04-12","postal_code":"34000"}'))))
    assert client.events[-1][1]['payload']['arguments'] == {'redacted': True}
    tracker.on_tool_update(event('tool_execution_updated', update=SimpleNamespace(
        type='tool_call_ended', call_id='private-call', status='success',
        message='{"status":"error","code":"SERVICE_UNAVAILABLE"}')))
    assert client.events[-1][0] == 'tool.failed'
    assert '1988-04-12' not in str(client.events)
