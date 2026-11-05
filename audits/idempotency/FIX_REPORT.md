# Idempotency fixes and test report

Release update: these fixes were subsequently deployed to the live system on 4 November 2026. See [DEPLOYMENT.md](DEPLOYMENT.md) for versions, live checks, and verification limits. The “not deployed” statements below describe the earlier local-test phase.

4 November 2026. These are local repository changes; nothing was deployed and no production records, real callbacks, or funds were touched. This report supersedes the unfixed-state findings in RESULTS.md. Historical audit tests were converted to regression assertions for the new contracts; their former expected failures were removed.

## 1. Duplicate session creation — fixed

The browser now generates an Idempotency-Key once per call attempt, retains it across uncertain HTTP responses and reloads, and uses a new key after an established call ends. Pending keys are normalized by agent/customer/direction and cleared on sign-out. The Edge Function requires the header and permits it in CORS.

The new session_start_requests ledger scopes keys to authenticated user IDs. An advisory transaction lock protects reservation before a row exists. Session, configuration snapshot, customer binding, and request receipt are created atomically. Changed settings under the same key return IDEMPOTENCY_KEY_REUSED. Replays use the saved configuration and session.

A durable reserved→dispatching claim allows one request to dispatch. After an uncertain dispatch response, retries inspect LiveKit's dispatch list for the same room/session. They never issue another dispatch blindly. A confirmed dispatch returns a participant token; unresolved outcomes return HTTP 202 SESSION_START_PENDING. Closed sessions reject replay.

Evidence: 12 session validation tests, including nine actual-handler scenarios backed by local SQL and three direct SQL/privilege probes. Twelve independent SQL connections reserve one session; twelve claims produce one owner. Handler scenarios cover concurrency, changed settings, missing keys, closure, room response loss, dispatch response loss, receipt acknowledgment loss, and unresolved dispatch. Four additional browser regressions cover transport loss, pending responses, intentional new calls, and reload with reordered settings.

Limit: a crash between claiming dispatch ownership and sending the remote request can remain pending. An empty provider list is not definitive proof of nonexecution. Resolving this requires provider/operator reconciliation; the code deliberately does not trade duplicate prevention for an unsafe automatic resend. A separately issued new key is a new operation, so callers must preserve uncertain keys.

Files: supabase/functions/livekit-session/index.ts, ui/app.js, migration 20261104000010_session_idempotency.sql.

## 2. Callback retries with regenerated tool-call IDs — fixed within an explicit operation boundary

Callback identity is now (session, runtime user-message ID, normalized UTC callback time). The runtime supplies user-message evidence; the model cannot supply an operation ID. Repeated tool calls for the same message and time reuse the stored receipt. Equivalent timezone offsets normalize to the same action. A later user message or changed callback time remains a distinct action. No user-message evidence means USER_MESSAGE_REQUIRED and no callback effect.

The operation ID is persisted on follow_up_requests with a unique index. SQL independently checks it against the runtime message ID and timestamp. Durable uniqueness still returns the original callback UUID if transition-level state memoization is lost. State, effect, receipt and audit remain transactional.

Evidence: five pure transition regressions; a real LiveKit AgentSession with a scripted provider emits two differently identified tool calls for one user message and creates one effect, then creates another for a later user message. Actual SQL tests cover regenerated IDs, equivalent offsets, lost ACK plus backend restart, missing/mismatched operation evidence, and uniqueness after state-map loss. Existing concurrency, rollback and connection-termination tests also pass.

Limit: this is deliberately not semantic intent classification. A new user-message ID or a different resolved callback timestamp is distinct; the system does not infer that two separate messages mean the same intent. Existing callback rows without operation evidence are not retroactively merged.

Files: Livekit-Agents/src/collection.py, Livekit-Agents/src/collection_backend.py, migration 20261104000011_collection_idempotency.sql. Existing ConfiguredAssistant message-evidence wiring is exercised by the SDK regression.

## 3. Same key with changed tool/arguments — fixed

Receipts now bind tool name and a SHA-256 fingerprint of PostgreSQL JSONB arguments. Object key ordering does not affect identity. Snapshot replay and atomic commit both reject mismatched reuse without changing the original effect, receipt, audit, or state version. Legacy receipts with no fingerprint fail closed as IDEMPOTENCY_LEGACY_RECEIPT instead of exposing an unverifiable historical result.

Verification answers travel to the trusted SQL function for fingerprinting, but raw DOB/postal-code values are not persisted in the collection operation receipt or audit arguments. Audits retain only a redaction marker; fingerprints remain worker-only data and are not a claim of anonymization.

Evidence: changed arguments, changed tool, reordered JSON, legacy receipts, session isolation, redacted persisted audit, and direct SQL collisions. Twelve parallel different payloads under one key produce one winner and eleven mismatch rejections, with one effect and one receipt.

Files: collection_backend.py and migration 20261104000011_collection_idempotency.sql.

## 4. Webhook upsert/index failure and acknowledgment reliability — fixed

The new migration replaces the partial session_events unique index with a full unique index on (source, source_event_id). PostgreSQL can now infer the handler's ON CONFLICT target. Multiple NULL event IDs remain allowed.

Handler validation also found ignored database errors when updating processing markers. The handler now checks those results and marks the raw webhook receipt processed only after materialization succeeds. Successful retries clear the processing error. Unknown lifecycle timestamp-update errors also propagate for retry.

Evidence: ten concurrent SQL upserts create one event while two NULL-ID inserts remain separate. Six actual-handler scenarios execute against real tables with mocked signature verification: ordinary replay, eight concurrent deliveries, and failures at event append, lifecycle update, materialized marker, and final receipt marker. Each failed attempt remains retryable; retry completes with one receipt/event and the expected lifecycle state. The production WebhookReceiver signature boundary is unchanged and was not exercised with live credentials.

Files: supabase/functions/livekit-webhook/index.ts and migration 20261104000012_session_events_idempotency_index.sql.

## 5. External callback execution — no executor exists in this repository

request_callback saves a pending request; it does not place a telephone call. There is no downstream execution path here to patch or certify. A future consumer must pass the persisted follow_up_requests.id as its provider operation identity and reconcile uncertain outcomes. Payment commitments similarly record promises, not transfers. The local fixes do not claim end-to-end exactly-once behavior across an unimplemented external service.

## Final verification

| Check | Result |
|---|---|
| Full Python application plus audit suites | 131 passed, 1 skipped in 19.56 seconds |
| Audit regression subset within that run | 77 passed; no expected failures |
| Browser and relevant JavaScript helper suites | 36 passed, including 23 browser tests |
| All current migrations on an empty database | 12 applied successfully; repeated on a second empty database after final transaction wrapping |
| Ruff on changed collection source/tests | Passed |
| JavaScript syntax and git diff whitespace checks | Passed |

The one skipped Python case is the existing opt-in paid real-model test. The scripted-provider SDK test checks tool plumbing and identity mechanics, not natural-language interpretation. External SDK/API boundaries are mocked in handler tests; database writes, locks, constraints, faults and connection termination are real local PostgreSQL operations.

Commands:

```sh
python3 audits/idempotency/database/prepare.py
IDEMPOTENCY_TEST_DB_CONFIG=/tmp/database-team-cluster.json UV_CACHE_DIR=/tmp/idempotency-fix-uv uv run --project Livekit-Agents pytest Livekit-Agents/tests audits/idempotency -q
node --test ui/tests/test-calls.test.cjs supabase/functions/livekit-session/configuration.test.mjs supabase/functions/livekit-webhook/lifecycle.test.mjs supabase/functions/session-observability/usage.test.mjs supabase/functions/tools/validation.test.mjs
```

The database preparation helper creates a disposable socket-only cluster. It requires local PostgreSQL 16. Stop the cluster with pg_ctl using the root directory in the generated configuration. No production default is needed for this audit.

## Team participation and review limits

Three agents contributed: session implementation, collection implementation, and independent security/database validation design. The independent reviewer challenged operation identity and dispatch uncertainty and authored the initial seven real-SQL validation cases. All three agents subsequently hit their service usage limit before final review. The root agent completed the collection migration, integration fixes, additional session/webhook/security tests, fixture updates, and final verification. There is no claim that an independent agent signed off on the final combined patch.

The prior audit's lead/validator reports remain historical evidence. New tests live in fix_validation/, test_collection_idempotency.py, the SDK runtime suite, and the browser suite. Existing unrelated voice/transcript work was preserved.

Official LiveKit testing documentation was checked at https://docs.livekit.io/testing/unit-tests.md. Generic documentation feedback about testing repeated tool calls and durable identity was submitted through the reading-livekit-docs skill; no project or personal data was included.

## Release requirements

The three new migrations must be applied and the updated Edge Functions, worker, and UI released together after draining old worker sessions. The collection RPC signatures changed. Old receipts deliberately fail closed, and old callback records cannot acquire missing original intent evidence automatically. The repository also contains unrelated voice work; deployment must account for its migrations separately.

Production schema, JWT/PostgREST authorization, real dispatch delivery and an external callback executor are not certified by these local tests. Local SQL privilege probes cover repository grants and negative browser-role access; transaction tests run with the fixture owner. No production deployment was performed.

Cleanup: the disposable PostgreSQL cluster was stopped successfully after all checks.
