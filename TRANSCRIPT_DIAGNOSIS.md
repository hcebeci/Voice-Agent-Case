# Missing transcript diagnosis — 17 October 2026

No fixes applied. Existing uncommitted changes were preserved. Database access was read-only.

## 4 November follow-up: screenshot STT zero-duration finding

The new screenshot shows **STT = 0 ms**, while **TTS averages 2,607 ms**. Queried the Collector Agent's 16 sessions read-only: 213 traces, 40 stored turns, and 662 events. Executing the actual `buildAgentMetrics` function against these records reproduced 16 sessions, STT average/p50/p95 of 0, and rounded TTS average of 2,607 ms.

All **66 STT traces** have `metadata.streamed=true` and `duration_ms=0`; their summed audio input duration is **671.75 seconds**. All **31 TTS traces** have nonzero durations, averaging **2,607.452 ms**. Therefore the STT zeros do not mean zero audio or instantaneous recognition.

The installed SDK's `stt/stt.py` streaming recognition-usage monitor explicitly constructs `STTMetrics(duration=0.0, streamed=True, ...)`. It emits those metrics from `RECOGNITION_USAGE`, independently of `FINAL_TRANSCRIPT`. The SDK's metric definition documents duration as zero for streaming. Official documentation confirms this: https://docs.livekit.io/testing/observability/data/ .

Application error chain:

1. `observability.py:on_component_metrics` treats the SDK usage metric's `duration` as a measured stage duration and constructs a completed trace with identical start/end times.
2. The same function defaults absent duration values to zero, further conflating unavailable and measured-zero timing.
3. `agent-metrics/index.ts` accepts every numeric duration >= 0, so the 66 placeholder zeros become average/p50/p95 latency values.
4. `ui/app.js` faithfully displays those numbers as `0 ms`.

A metrics event contains usage/timing metadata, **not recognized transcript text**. Our text log instead depends on the separately handled final `user_input_transcribed` event and assistant `conversation_item_added` event. A completed metric trace establishes neither transcript completeness nor durable recording of the corresponding text.

In the affected October 15 session, the six received final-user-text observations arrived 564, 585, 667, 577, 547, and 594 milliseconds after their immediately preceding speech-stop observations. These are observed pipeline event delays, not isolated provider compute measurements. They demonstrate actual nonzero delays despite all STT stage metrics displaying zero.

That session's worker receipt history remains contiguous 1–71, ending with event 70 `trace.stt` and event 71 `session.usage`. Turn 5 still has no persisted user/agent text or terminal event. Its worker receipts have no processing errors. The earlier conclusions about misassignment, overwrite, and the unproven precise tail-loss point remain applicable; the zero-duration display is a separate metric interpretation defect.

Two processing errors exist in older September 27 sessions, both `tool.started` observations rejected for a missing matching ON CONFLICT constraint. Neither belongs to the affected session or explains these streaming STT zeros.

Five new diagnostic tests passed using the installed SDK's actual recognition-usage monitor and application tracker: zero completed trace without transcript; successful text with the same zero metric; absent duration defaulting to zero; all 66 real zeros being streaming metrics; and the affected session's missing event tail. A separate execution of the actual TypeScript aggregator reproduced the screenshot. Temporary harnesses: `/tmp/test_stt_recording_reliability.py` and `/tmp/stt-agent-metrics-reproduction.mts`. The read-only snapshot `/tmp/recording-reliability-20261104.json` contains call data and is not committed.

Recording reliability should be addressed independently of semantic grouping. Streaming STT duration should be represented as unavailable for this metric; observed transcription delay should be measured separately with valid speech/transcript correlation. Metrics receipts must not substitute for transcript capture or session-completeness checks. No runtime fixes were applied in this investigation.

## Follow-up: interruptions and audible Turn 5 answer

The user confirms the agent audibly answered Turn 5. Therefore the absence of a Turn 5 response in stored observations must not be interpreted as absence of an actual response. The capture/delivery history is incomplete. The exact historical loss point remains unproven.

Current interruption configuration is conditional: `interruption.enabled = bool(collection_backend)`. Collection calls enable it; calls without that backend disable it. `create_payment_commitment` and `request_callback` explicitly call `context.disallow_interruptions()`, so the application does not universally guarantee interruption. Proposal review speech explicitly permits interruptions. The affected session snapshot includes collection tools, and collection tool receipts prove the backend was active, but the stored snapshot does not preserve effective interruption options or establish the exact deployed code revision.

Voice-activity traces and STT text are independent observations. VAD detects speaking boundaries; STT emits interim and final recognition results; the logger drops interim results and saves only nonempty final results. A final STT segment is not necessarily a complete grammatical sentence or an entire conversational turn. Agent text is captured when an assistant conversation-history item is added, not directly from the first generated token or the audio-start event. Interruption may separate these lifecycle events.

An additional confirmed instrumentation defect explains absent LLM spans across the timeline: `agent.py` supplies `llm` to `ConfiguredAssistant`, not `AgentSession`, while component metrics registration checks `session.llm` and skips `None`. A runtime check confirmed `AgentSession().llm is None`, and AST checks confirmed those constructor argument placements. This does not by itself explain missing final TTS/audio/text receipts, but it makes the trace view incomplete even without delivery loss.

## Evidence and reproduction

The screenshots match session `06249f2c-baaa-4fc8-8018-b59bdb848358`, started 15 October at 22:50:23 Istanbul time. Queried its five stored turns, 73 raw events (71 worker events and two collection events), and 24 traces.

Replayed the recorded event order through the current production `TurnTracker`, then applied the materializer's transcript assignment rules. **All ten transcript fields match the database exactly**, including the empty fields. This reproduces the reported symptom without a browser or network dependency.

## Confirmed primary cause: transcript ownership follows mutable current turn

`Livekit-Agents/src/observability.py:292` clears the current turn as soon as the agent leaves the speaking state. `on_conversation_item`, line 251, later calls `ensure_turn()` instead of identifying the exchange that produced that message.

The exact affected sequence, in Istanbul time:

1. 22:51:09.920 — Turn 2 agent audio starts (worker event 24).
2. 22:51:23.932 — Turn 2 is marked completed and the tracker resets (event 28).
3. 22:51:29.493 — the next user transcript arrives in Turn 3 (event 33).
4. 22:51:29.510 — the previous agent response finally arrives (event 34). Its own metrics identify its audio start as 22:51:09.919, matching Turn 2. It is nevertheless assigned to the current Turn 3.
5. 22:51:49.818 — Turn 3's actual response arrives (event 44), replacing that misplaced text.

Consequently Turn 2 has audio and completed status but no response text. The text was captured and persisted in raw events; the turn projection loses it through misassignment and subsequent replacement. The current database cannot reconstruct event turn ownership directly from `session_events`: worker receipts have null `turn_id`, and the incoming `turn_number` is not stored in their payload.

## Confirmed additional loss: final user segments replace earlier segments

`supabase/functions/session-observability/index.ts:103` assigns each final STT transcript to `user_transcript` with an upsert. It does not preserve previous segments for the same turn.

In this session, worker events 13/19, 33/39, and 51/57 are three pairs of final transcripts. Each pair maps to one turn, and only its second segment survives in the stored turn. The raw events retain both segments. This is why utterances spanning multiple final STT segments appear incomplete.

## Turn 1: absent user message is expected, label is misleading

Turn 1 is an outbound agent greeting. There is no user transcript event for that turn. `ui/app.js:544` displays “Transcript pending” for every empty user field, including an agent-only greeting. It also falls back to the database insertion timestamp for the user timestamp, which makes a nonexistent user message appear to follow the greeting. This is a presentation issue, not evidence of lost user speech on Turn 1.

## Turn 5: missing event tail; shutdown loss strongly supported, not historically proven

The final user-speech-stop event exists, followed by STT metrics and usage events. No corresponding final transcript, response, cancellation, or completion receipt exists. Worker sequence numbers are contiguous from 1 through 71; the history ends there. All received worker events are marked processed and have no processing error.

Delivery is serial and backed only by an in-memory queue (`observability.py:128`). The last received event occurred at 22:52:28.741 but reached the backend at 22:53:15.798: **47.057 seconds of lag**. The database session ended at 22:52:46.535, so observations continued arriving after room completion.

Normal close schedules the flush in a background task (`agent.py:314–317`); the application does not register that telemetry flush as an awaited job shutdown callback. The installed worker has a default shutdown process timeout of ten seconds. This combination can lose queued transcripts and final status observations when the job exits.

A cancellation test using the real `ObservabilityClient` sender reproduced loss of 17 of 20 queued/in-flight events. This establishes the failure mode, not proof that event 72 contained Turn 5's transcript. Historical logs could not be retrieved: LiveKit reported that the agent had shut down due to inactivity. Distinguishing a lost queued transcript from an STT/callback failure on this final utterance requires historical worker logs or a captured session trace; the surviving receipts cannot establish which happened.

## Tests and alternatives evaluated

| Probe | Result |
| --- | --- |
| Existing observability and transcript handler tests | 10 passed |
| Full affected-session replay | All 10 stored text fields matched |
| Delayed assistant message retains original turn | Fails: turn 2 instead of turn 1 in minimal reproduction |
| Multiple final STT segments retain full utterance | Fails: only second segment survives |
| Serial sender retains all events after cancellation | Fails: 17/20 lost |
| Receipt sequence and processing health | Passed: contiguous 1–71, all worker receipts processed, no processing errors |
| Actual TypeScript materializer with recording database | Confirmed user segment replacement and misplaced assistant overwrite |
| Timing/status event clears existing transcript | Ruled out in actual materializer execution: unrelated text survives |
| API omits transcript columns | Ruled out by inspection: both fields explicitly selected |
| UI fails to render existing text | Stored empty fields explain screenshot placeholders; full backend replay reproduces them |
| Identity-verification redaction | Surviving raw text is present; redaction does not explain the reproduced empty fields |
| Shutdown tail loss versus missing STT/callback | Tail loss reproduced; exact historical Turn 5 trigger remains unverified |

Existing tests exercise assistant text before the end-of-speaking state transition, so they miss the recorded delayed-message ordering. The transcript visibility test checks callback registration and text forwarding but does not test turn lifecycle or segment accumulation.

Temporary diagnostic harnesses: `/tmp/test_transcript_diagnosis.py` and `/tmp/transcript-materializer-test.mts`. Raw read-only session snapshots are in `/tmp/transcript-session_events.json`, `/tmp/transcript-session_turns.json`, and `/tmp/transcript-session_traces.json`; these contain call data and were not added to the repository.

Commands used:

```sh
cd Livekit-Agents
UV_CACHE_DIR=/tmp/codex-uv-cache uv run --no-sync pytest tests/test_observability.py tests/test_transcript_visibility.py -q
UV_CACHE_DIR=/tmp/codex-uv-cache uv run --no-sync pytest /tmp/test_transcript_diagnosis.py -q -s
node --experimental-strip-types /tmp/transcript-materializer-test.mts
```

LiveKit's event reference distinguishes conversation-history commits from speaking-state transitions; these should not be assumed to occur as a single atomic lifecycle event: https://docs.livekit.io/reference/agents/events/ . The diagnosis itself rests on the captured event order and executable local tests.
