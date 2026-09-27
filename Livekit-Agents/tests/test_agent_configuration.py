from agent import (
    DEFAULT_INSTRUCTIONS,
    parse_job_metadata,
    resolve_agent_configuration,
    session_id_from_room_name,
)


def test_parse_job_metadata_rejects_non_object_values():
    assert parse_job_metadata("[1, 2, 3]", "browser-room") == {}


def test_browser_room_name_recovers_uuid_session_id():
    session_id = "123e4567-e89b-12d3-a456-426614174000"
    assert session_id_from_room_name(f"browser-{session_id}") == session_id
    assert session_id_from_room_name("room-without-session-id") is None


def test_agent_configuration_uses_dispatch_instructions_when_present():
    instructions, model, language, source = resolve_agent_configuration(
        {
            "instructions": "  Answer in one sentence.  ",
            "model": "  model-x  ",
            "language": "tr",
        }
    )

    assert instructions == (
        "Respond in Turkish unless the user explicitly asks to switch languages.\n\n"
        "Answer in one sentence."
    )
    assert model == "model-x"
    assert language == "tr"
    assert source == "job_metadata"


def test_agent_configuration_falls_back_only_when_instructions_are_empty():
    instructions, model, language, source = resolve_agent_configuration({"instructions": "  "})

    assert instructions == (
        "Respond in English unless the user explicitly asks to switch languages.\n\n"
        + DEFAULT_INSTRUCTIONS
    )
    assert model == "google/gemma-4-31b-it"
    assert language == "en"
    assert source == "default"
