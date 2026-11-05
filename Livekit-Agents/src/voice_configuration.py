"""Resolve hosted voices. Only voice identifiers are persisted, never audio."""
import json
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name("voice_catalog.json").read_text())
MODELS = {model["id"]: model for model in CATALOG["models"]}
LEGACY_VOICES = {
    "inworld/inworld-tts-2": "Ashley",
    "cartesia/sonic-3": "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
}


def resolve_voice(metadata: dict) -> tuple[str, str]:
    model_id = metadata.get("tts_model") or "inworld/inworld-tts-2"
    if not isinstance(model_id, str):
        raise ValueError("Unsupported TTS model")
    if model_id in LEGACY_VOICES:
        voice = metadata.get("voice") or LEGACY_VOICES[model_id]
        if not isinstance(voice, str) or not voice.strip():
            raise ValueError("Invalid TTS voice")
        return model_id, voice
    model = MODELS.get(model_id)
    if not model:
        raise ValueError("Unsupported TTS model")
    voice = metadata.get("voice") or model["default_voice"]
    if voice not in {item["id"] for item in model["voices"]}:
        raise ValueError("Unsupported voice for the selected TTS model")
    return model_id, voice
