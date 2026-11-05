# Review implementation status — 5 November 2026

The review fixes are implemented and release-reviewed locally. No hosted migrations, Edge Function
deployment, real-model evaluation, cloud audio simulation or paid inference was
performed. Telephony is deferred by the user's explicit choice. Existing manual
audio testing in both browser directions is user-reported evidence, not replaced
or relabeled by scripted runs.

| Order | Work completed |
| --- | --- |
| 1. Reproducible setup | One dynamic ordered migration plan includes historical manual SQL and every current migration; setup covers non-destructive upgrades. |
| 2. State and evidence integrity | Runtime/audit writes are server-owned; browser closure is owner-bound and terminal; dashboard reads no longer fail healthy long calls; agent/tool saves are atomic and new call snapshots are captured under the same row lock. |
| 3. Browser correctness | Sign-out/auth loss tears down calls; in-flight requests cannot reconnect after logout; save retries and stale responses are guarded; per-agent history has cursor pagination. |
| 4. Logging | Actual LLM metric listener attached; SQLite outbox keeps stable events through retries/process exit; turn projections handle reverse delivery/stale revisions; usage aggregation is monotonic. |
| 5. Retained test history | Authenticated history API/UI, complete synthetic evidence, manual audio review snapshots, immutable report IDs, explicit execution type and provenance. |
| 6. Collection validation | Seven pinned-clock scenarios with uncensored fictional identities; scripted SDK mechanics, opt-in model + semantic judges, cloud simulation final-state vetoes, separate audio interruption case. |
| 7. Regression and CI | Offline suites, actual handler/SQL/worker boundaries, disposable database provisioning, and CI artifact retention on failure. |

## Checks executed

- Python: **108 passed, 1 skipped**. The skipped test is the opt-in real-model case.
- JavaScript: **78 passed**.
- Scripted scenarios: **7 passed**. These prove mechanics/final effects, not natural-language interpretation or audio.
- Fresh disposable PostgreSQL: **18 migrations** and three SQL suites passed.
- Actual observability Request/Response handler → SQL → session serializer:
  reversed arrival, stale transcript, duplicate event/trace, usage ordering,
  retry after partial processing and uncensored synthetic values passed.
- Production `CollectionBackend` → actual SQL: verification/minimum/review
  guards, exact saved amount/date, lost acknowledgement, replay and unchanged
  balance passed.
- Final review corrected container simulation evidence paths to a writable application directory, with regressions for repository/container layouts and an optional persistent-volume override (`VOICE_AGENT_EVALUATION_OUTPUT_DIR`). Five answer-speed report regressions also pass.
- Changed Python files pass targeted Ruff checks; UI syntax and diff whitespace
  checks pass. Voice catalog consistency check passes.

## Verification boundaries

The SQL fixture substitutes only its Supabase SDK transport/auth adapter. It
does not test the deployed JWT gateway or CORS. Frontend tests use a DOM/media
harness; no visual browser or new microphone/carrier test was completed here.
Real-model judges and cloud audio are ready but unrun to avoid inference charges.

Persist the outbox on a durable volume for worker replacement recovery. Capacity
exhaustion/disk failure can reject captures explicitly; permanent oldest-event
failures can delay later delivery. No scheduled authoritative stuck-room
reconciler was added. CI artifacts expire after 30 days; retained local reports
and hosted history have no automatic deletion introduced by these changes.

For commands, safe database setup, report publishing and reviewer use, see
[VALIDATION.md](VALIDATION.md). Apply matching migrations and deploy `test-runs`
and changed functions/worker before using the new hosted behavior. Nothing in
this change clears the existing assessment database.
