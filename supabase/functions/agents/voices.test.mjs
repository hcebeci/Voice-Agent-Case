import { test } from "node:test"
import assert from "node:assert/strict"
import { validateVoiceConfiguration } from "./voices.mjs"

test("selected multilingual voice is accepted for its model", () => {
  assert.equal(validateVoiceConfiguration({ tts_model: "xai/tts-1", voice: "ara" }), null)
  assert.equal(validateVoiceConfiguration({ tts_model: "google/gemini-3.8-flash-tts", voice: "Kore" }), null)
})
test("rejects cross-provider, arbitrary, and invalid voices", () => {
  for (const voice of ["Kore", "unknown", "", 42, {}]) {
    assert.ok(validateVoiceConfiguration({ tts_model: "xai/tts-1", voice }))
  }
  assert.ok(validateVoiceConfiguration({ tts_model: "assemblyai/assemblyai-tts-1", voice: "Alba" }))
})
test("missing voice selects provider default; existing settings remain valid", () => {
  assert.equal(validateVoiceConfiguration({ tts_model: "xai/tts-1", voice: null }), null)
  assert.equal(validateVoiceConfiguration({ tts_model: "inworld/inworld-tts-2", voice: null }), null)
})
