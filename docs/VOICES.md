# Hosted multilingual agent voices

Users can select a provider and voice in Create/Edit agent. The worker receives
`tts_model` and `voice` in the existing dispatch metadata and passes both to
`inference.TTS`. Changes apply to new calls; calls already running keep their
configuration.

No voice models or audio files are downloaded to application storage or stored in
Supabase. Supabase stores only the selected model and voice IDs. Speech is
synthesized remotely through LiveKit Inference and delivered to the call.
Playback necessarily transfers audio bytes into the browser, which may buffer
or cache them. This is different from keeping voice assets in your application.
LiveKit Inference usage is billed to the configured LiveKit project.

## Included voices

The catalog includes all 30 Google and 26 xAI voices in the supplied list. These
support both of the application's languages, English and Turkish. Model IDs:

- `google/gemini-3.8-flash-tts` (case-sensitive voice IDs, such as `Kore`)
- `xai/tts-1` (lowercase voice IDs, such as `ara`)

Existing Cartesia and Inworld settings are preserved when editing saved agents.
New agents default to xAI Ara. A provider change resets the selection to that
provider's default. The API, database constraint, and worker reject voice IDs
belonging to the wrong provider for the new models.

The supplied AssemblyAI names could not be verified in LiveKit's current voice
catalog on November 4, 2026. Its documented TTS model supports English, Spanish,
German, French, Italian, and Portuguese, without Turkish. Those names are omitted
instead of inventing voice IDs or substituting different voices.

## Demo and validation

With `python3 start.py` running, open
[the voice demo](http://127.0.0.1:8000/voice-demo.html). It requires no login.
All 56 voices appear in a searchable table with individual play/pause buttons.
The 26 xAI English samples play directly from `static.livekit.io`. The 30 Google
voice references stream from Google Cloud’s official documentation. These use
Chirp 3 HD, so delivery may differ from Gemini calls; the library and playback
status disclose this. No preview backend or audio bucket is required. Only one
sample plays at a time. Arrow keys navigate the play buttons.

Live speech verification generated `Merhaba.` with xAI Ara and Google Kore using
this project's LiveKit credentials. Both returned audio successfully; frames were
consumed only in memory. This checks representative model connectivity, not the
quality of every voice or a complete browser call.

## Enable in a deployed environment

1. Apply `supabase/migrations/20261104000001_multilingual_agent_voices.sql` using
   the project's normal migration workflow. Existing saved agents are unchanged.
2. Deploy the updated `agents` Edge Function, including its catalog and validator.
3. Restart/redeploy the Python worker with `voice_configuration.py` and
   `voice_catalog.json` included.
4. Serve the updated UI, including `voices.js`, `voice-catalog.json`, and demo files.

The current `livekit-session` function already forwards both settings; this
feature does not require changing its dispatch logic. No new provider keys or
Python dependencies are needed. These source changes do not deploy themselves.

`ui/voice-catalog.json` is the canonical metadata snapshot. After updating it,
run `python3 scripts/sync-voice-catalog.py` to copy it into the isolated worker
and Edge Function deployment directories. Run with `--check` to detect drift.

Checks:

```sh
node --test ui/tests/*.test.cjs supabase/functions/agents/voices.test.mjs
UV_CACHE_DIR=/tmp/voice-agent-uv-cache uv run --project Livekit-Agents --no-sync pytest Livekit-Agents/tests/test_voice_configuration.py Livekit-Agents/tests/test_agent_configuration.py -q
python3 scripts/sync-voice-catalog.py --check
```

Sources: [LiveKit TTS overview](https://docs.livekit.io/agents/models/tts/),
[xAI TTS](https://docs.livekit.io/agents/models/tts/spacexai/),
[Google Gemini TTS](https://docs.livekit.io/agents/models/tts/gemini/),
[AssemblyAI TTS](https://docs.livekit.io/agents/models/tts/assemblyai/).
The voice metadata and xAI sample URLs were verified against the public LiveKit
documentation site's model catalog and sample library on November 4, 2026.

## Live rollout — November 4, 2026

- Supabase project: `kbmroangudidkywlotbw` (`voice-agent-case`).
- Applied `20261104000001_multilingual_agent_voices.sql` as one transaction using
  the linked project's SQL query command. Historical migrations were not replayed.
- Deployed `agents` API version **10**, status **ACTIVE**, with user JWT
  verification retained.
- LiveKit agent `CA_gt5YfAPeqxha`, version `C2JBooEMZSed`, is running. Its release
  manifest matches the current worker entrypoint, voice resolver, and catalog
  byte for byte. No additional worker restart was necessary.
- Rechecked Turkish synthesis after deployment: xAI Ara and Google Kore both
  returned audio frames in memory.
- The UI is served by the existing local server. Refresh the agent manager to
  load the voice selector; no separate frontend build is required.
- Browser sign-in was not available during rollout, so a signed-in browser
  save-and-call flow was not tested. Local regression checks passed: 30
  JavaScript tests and 12 Python configuration tests.
- Live database API smoke checks accepted Turkish configurations for xAI Ara
  and Google Kore, rejected a cross-provider voice pair, and removed both
  temporary test agents afterward. The earlier SQL smoke-check connection failed
  before running; REST checks supplied the save verification instead.
- Confirmed the running frontend serves the updated editor, picker script, and
  catalog successfully (HTTP 200).
