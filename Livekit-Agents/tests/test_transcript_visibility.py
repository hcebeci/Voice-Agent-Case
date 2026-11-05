from types import SimpleNamespace

from agent import register_transcript_handlers
from observability import TurnTracker
from test_observability import RecordingClient


def test_session_events_preserve_full_verification_dialogue():
    handlers = {}
    session = SimpleNamespace(on=lambda name: lambda callback: handlers.setdefault(name, callback))
    client = RecordingClient()
    register_transcript_handlers(session, TurnTracker(client))

    handlers["user_input_transcribed"](SimpleNamespace(
        transcript="My birth date is April 12, 1988, postal code 34000.",
        is_final=True, language="en", created_at=100.0,
    ))
    handlers["conversation_item_added"](SimpleNamespace(
        item=SimpleNamespace(role="assistant", text_content="Please confirm your date of birth.", metrics={}),
        created_at=101.0,
    ))

    assert client.events[0][1]["payload"]["transcript"] == "My birth date is April 12, 1988, postal code 34000."
    assert client.events[1][1]["payload"]["transcript"] == "Please confirm your date of birth."
