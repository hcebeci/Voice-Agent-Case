# Answer-speed optimization review

Local review and measurements: 5 November 2026. Three optimization teams worked
in parallel, then cross-reviewed each other's changes. Existing uncommitted
application work was preserved. No deployment was performed.

## Current answer speed and measurement quality

The saved `DATA/session_turns_rows.csv` export contains 67 turns across 20
sessions. Of these, 51 have stored response latency: **p50 2,865 ms, p95
8,149 ms, maximum 22,643 ms**. Thirty-eight of those 51 exceed two seconds and
four exceed five seconds. This is historical evidence, not a controlled baseline
for the current checkout or a production before/after comparison.

The export has no model-start, first-token or model-completion timestamps and
no positive input/output token counts. Nineteen timestamp pairs place first
audio before the recorded user speech stop. Only 34 nonnegative timestamp pairs
can independently reconstruct onset latency. Missing measurements must not be
treated as zero. These gaps prevent attributing the historical delay to model
inference, endpoint detection, tools or synthesis. Existing in-progress telemetry
changes were not counted as optimizations delivered by these teams.

Run `python3 scripts/analyze-answer-speed.py` to reproduce the aggregate report.
Use `--data-dir /path/to/new/export` for a fresh export. It never prints customer
identifiers or transcript text. p95 uses the nearest-rank definition.

## Changes and measured results

These measurements use different boundaries and **must not be added together**
or described as a measured reduction in spoken response latency.

| Team and measurement | Before | After | Scope |
| --- | ---: | ---: | --- |
| Algorithm: recover a committed tool result after its HTTP response is lost | 265.68 ms | 65.37 ms | Median of 10 synthetic runs, 20 ms/request; three requests in both versions |
| Algorithm: permanent HTTP 403 on snapshot | 265.69 ms | 21.49 ms | Same fixture; three requests reduced to one |
| Algorithm: ordinary successful execution | 43.41 ms | 43.64 ms | No meaningful improvement; two authoritative RPCs retained |
| Algorithm: retry needing another write | 287.62 ms | 309.31 ms | Four → five requests: fresh state read after backoff preserves concurrent-change handling |
| JavaScript: 100 caption updates with 120 historical turns | 497.65 ms | 26.19 ms | Median of five batches; actual renderer with DOM stubs, excludes browser layout/audio |
| Runtime: durable event capture with 9,000 queued events | 10.519 ms | 0.353 ms | Median of 100 local captures with ~2 KB queued bodies; excludes network delivery |
| Runtime: same loaded capture, p95 | 19.654 ms | 0.568 ms | Machine/storage dependent; CI uses operation counts, not timing thresholds |

Algorithm changes classify permanent HTTP failures without retrying them. After
an uncertain write, the backend reads the durable receipt immediately and waits
200 ms only when another write is needed. Request IDs, argument binding,
authoritative database state, commit checks and the existing retry budget remain
in force. Cross-review added a regression for another worker changing state during
backoff. The final implementation refreshes state after that wait before computing
a new effect. This adds one RPC to retries requiring another write, while receipt
recovery stays fast. This speeds failure recovery, not the ordinary successful path.

JavaScript changes reuse the caption timestamp formatter and allow connected-call
controls to become ready without waiting for a dashboard request. Cross-review
identified an out-of-order dashboard response race when a call is ended quickly;
the final change guards dashboard results and errors against stale requests and
authentication generations. Full-history HTML serialization still scales with
transcript length.

Runtime changes replace per-event `count/sum` scans of the telemetry outbox with
transactionally maintained SQLite counters. Database triggers cover inserts,
deletes and byte updates from other connections, including older workers.
Existing queues are counted once during migration. FULL synchronous durability,
commit-before-return, queue bounds and explicit capture errors are preserved.
Empty-queue median cost was about 0.28 ms both before and after; this improvement
matters most during delivery backlogs. Disk commits remain synchronous.

## Team feedback loops and validation layers

| Team | Reproduction and correction loop | Correctness layers | Independent review |
| --- | --- | --- | --- |
| Algorithm | Actual backend under controlled HTTP failures; failing retry-order tests → revised scheduling → repeat timing fixture → concurrent-state regression and correction | Permanent/retryable errors, lost acknowledgements, one durable effect, identity/state/idempotency suites; scripted conversations | Integration review checked retry ordering and completed the state-refresh correction |
| JavaScript | Count formatter construction and hold dashboard promises; fail tests → optimize → compare output → fix cross-review race | HTML escaping, partial/final ordering, call controls, stale dashboard results/errors/auth changes; 120 pre/post renderer comparisons | Algorithm team reproduced dashboard race; integration review completed the guarded-response correction |
| Runtime | Measure capture under increasing backlog; failing SQLite work-count test → constant-work counters → rerun | Queue migration, two connections, capacity/byte totals, rollback, delivery/restart tests, SDK wiring | JavaScript team independently reviews triggers and reruns tests |

The existing CI test globs include the new Node and worker regressions. The
latency report's five standard-library tests were also added to CI. Wall-clock
benchmarks remain diagnostic; deterministic operation counts and correctness
assertions are the regression gates.

Final local validation: **104 Python tests passed, one opt-in model test skipped;
78 JavaScript tests passed; five latency-report tests passed; seven scripted
conversation scenarios passed.** Targeted Python lint, JavaScript syntax and diff
whitespace checks passed. The runtime cross-review independently passed 11
capture/delivery tests. No multiprocess contention or power-loss experiment was
performed in this pass.

Reproduce from the repository root:

```sh
python3 -m unittest discover -s tests -p 'test_answer_speed.py'
node --test ui/tests/*.test.cjs supabase/functions/*/*.test.mjs
node ui/benchmarks/transcript.cjs
python3 scripts/analyze-answer-speed.py
cd Livekit-Agents
uv run --frozen --no-env-file pytest
uv run --frozen --no-env-file python tests/benchmark_collection_backend.py
uv run --frozen --no-env-file python benchmarks/observability_capture.py
uv run --frozen --no-env-file python src/evaluation.py --mode scripted
```

If the default uv cache is not writable, set `UV_CACHE_DIR` to a writable
temporary directory. The transcript benchmark accepts a saved baseline
`app.js` path; the backend benchmark accepts `--backend-file`. Baselines for this
run were copies of the dirty working tree before these edits, not Git HEAD.

## Remaining work to establish spoken-answer improvement

A live two-turn generic-agent text smoke test produced coherent replies, about
1.7 seconds per whole text turn and 1,576/1,532 ms to first model token. It does
not exercise collection tools, durable session telemetry, speech recognition,
endpointing, synthesis or browser playback. It is neither a before/after test
nor proof of lower time to first audio.

For a controlled audio comparison, hold the model, voice, language, region,
prompt, account fixtures and utterances constant. Retain both successful and
failed results. Measure user speech stop → first audible response at p50/p95,
separately for ordinary turns, tool turns and interrupted/corrected offers. Also
record completion rate, incorrect interruptions, confirmation behavior and exact
saved effects. Use the existing audio scenarios and manual call workflows in
[VALIDATION.md](VALIDATION.md); do not replace those gates with these benchmarks.

Priorities after collecting valid component timings:

1. Determine whether model time-to-first-token, turn detection, tool RTT or TTS
   dominates; optimize the largest measured contributor.
2. Evaluate shorter replies and smaller relevant prompt/tool context through
   real-model tests before changing conversation behavior.
3. Consider incremental caption DOM updates if long-call browser profiling shows
   remaining full-history rendering/layout cost.
4. Measure concurrent collection calls: the existing 12-second operation deadline
   begins after lock acquisition, so it does not bound time spent waiting for the
   lock. Changing this requires cancellation and durable-effect tests.

This pass did not alter model selection, endpointing thresholds, identity checks,
offer review or payment confirmation rules. No hosted audio benchmark or
deployment result is claimed.
