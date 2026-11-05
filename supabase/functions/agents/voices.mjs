import catalog from "./voice-catalog.json" with { type: "json" }

export const supportedTtsModels = new Set([
  "cartesia/sonic-3", "inworld/inworld-tts-2", ...catalog.models.map(model => model.id),
])

/** Validate the effective pair, including fields retained by a partial update. */
export function validateVoiceConfiguration(input) {
  const modelId = input.tts_model ?? "inworld/inworld-tts-2"
  if (!supportedTtsModels.has(modelId)) return "Agent TTS model is not supported."
  if (input.voice != null && (typeof input.voice !== "string" || !input.voice.trim())) {
    return "Agent voice must be a non-empty voice ID or null."
  }
  const model = catalog.models.find(model => model.id === modelId)
  if (model && input.voice != null && !model.voices.some(voice => voice.id === input.voice)) {
    return "Choose a multilingual voice belonging to the selected TTS model."
  }
  return null
}
