import pytest

from voice_configuration import resolve_voice


@pytest.mark.parametrize("model,voice", [("xai/tts-1", "ara"), ("google/gemini-3.8-flash-tts", "Kore")])
def test_selected_multilingual_voice_reaches_tts(model, voice):
    assert resolve_voice({"tts_model": model, "voice": voice}) == (model, voice)


def test_voice_cannot_cross_providers():
    with pytest.raises(ValueError, match="voice"):
        resolve_voice({"tts_model": "xai/tts-1", "voice": "Kore"})


def test_existing_agents_keep_their_default_voice():
    assert resolve_voice({}) == ("inworld/inworld-tts-2", "Ashley")
    assert resolve_voice({"tts_model": "cartesia/sonic-3"}) == (
        "cartesia/sonic-3", "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"
    )


def test_unsupported_provider_is_rejected():
    with pytest.raises(ValueError, match="model"):
        resolve_voice({"tts_model": "made/up", "voice": "Ara"})


def test_new_provider_default_is_used_when_voice_missing():
    assert resolve_voice({"tts_model": "xai/tts-1"}) == ("xai/tts-1", "ara")
