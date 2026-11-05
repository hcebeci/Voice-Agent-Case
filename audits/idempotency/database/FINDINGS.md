# Database team idempotency audit

Scope: fresh disposable PostgreSQL 16, no TCP, all eight checked-in migrations, stub auth schema and anon/authenticated/service roles. Synthetic fixtures only. No application/migration changes or production reads/writes. Tests use separate psql processes/connections; Python runtime HTTP boundary is mocked only to route requests into actual SQL functions and simulate lost ACKs.

## Initial loop and observations

1. Read prior audit as hypotheses, inspect SQL, independently rebuild cluster.
2. Run concurrency/fault suite: 14 passed, 2 strict expected failures.
3. Add same-proposal and mismatched-payload races. Repeated run exposed a test fixture reusing globally unique telemetry key, not an application regression. Replace fixture with UUID, rerun: 16 passed, 2 strict expected failures in 3.67 seconds.
4. Add complete lost-acknowledgment and before-write outage tests: 18 passed, 2 strict expected failures in 5.02 seconds.
5. Internal validator independently reran initial 18 passing tests, challenged missing state-update fault, and highlighted local-role limitations. Added state-update fault after callback insertion: revised suite 19 passed, 2 strict expected failures in 5.05 seconds. Validator independently reran new state-update test: 1 passed in 0.31 seconds. Three independently authored probes passed in 0.46 seconds: pre-COMMIT connection termination rollback/retry, stale-customer timestamp conflict/retry, and explicit permission-model limitation. Feedback loop closed; see validation/VERDICT.md. Security team independently agrees on receipt scope, mismatch behavior, role denial, stale state protections; database team challenged endpoint-auth and external-effect scope claims.

## Evidence ledger

- Same request ID, same session, repeated callback: one callback, identical result replay.
- Complete post-commit acknowledgment outage: OUTCOME_UNKNOWN, one committed callback; later same-key recovery yields original result with no additional commit. Outage before first snapshot: SERVICE_UNAVAILABLE, zero effects or receipts.
- Lost response after actual committed SQL: runtime receipt reconciliation returns success with one write attempt and one callback.
- 12 independent psql calls, same key: one callback and one receipt.
- 16 independent psql calls, distinct keys sharing version zero: one callback, 15 conflicts. Conflict creates no receipt; retry after refresh can succeed.
- 12 independent psql calls, same proposal/new request IDs: one commitment, 11 conflicts. Direct refreshed duplicate proposal attempt fails UNIQUE(proposal_id), with no added state version/receipt/audit. This direct SQL test bypasses runtime transition; runtime test separately returns COMMITMENT_ALREADY_EXISTS for new tool ID, same proposal.
- Concurrent same key but differing callback dates: one winning effect, all callers receive winning result silently. Stored arguments are not compared against replay arguments; no payload/tool mismatch error. This is intent-integrity limitation, not duplicate effect.
- Injected exceptions at callback insert, subsequent state update, receipt insert, and audit insert: business effect, receipt, audit and state version all remain absent/unchanged. Remove fault and retry original key: exactly one of each, version one. PostgreSQL transaction scope protects atomicity.
- Same callback arguments/new IDs: two callbacks. This can be either legitimate distinct intent or duplicate retry; database has no semantic identity to distinguish them. Strict expected failure documents desired one-logical-action protection when IDs regenerate; not a universal requirement to reject equal arguments.
- Telemetry key (source, source_event_id): duplicate within source rejected even across sessions; another source accepted. NULL source_event_id does not deduplicate. Worker retry test retains one event ID across three attempts.
- Webhook-equivalent ON CONFLICT(source,source_event_id) against session_events: PostgreSQL cannot infer partial unique index. Strict expected failure confirms known fresh-schema processing gap; not direct evidence of duplicate business effect.

## Replay and failure boundaries

Receipt scope is (session_id, request_id), not payload equality. Same-key replay occurs before version/status validation, so stored success can be returned despite later session changes. Recovery relies on preserving original request ID and eventually reaching receipt lookup. If the commit and all lookup acknowledgments are lost, outcome remains unknown until later retry/reconciliation; absence of a response is not absence of effect.

Atomic transaction is not a durable inbox for unsubmitted work. The DB cannot protect a request never delivered, cannot infer two newly minted IDs represent one user action, and cannot ensure future scheduled callbacks execute once in an external provider. Payment commitments are promises, not payment transfers.

## Reproduce

Run `python3 audits/idempotency/database/prepare.py`, then `Livekit-Agents/.venv/bin/python -m pytest audits/idempotency/database/test_database_idempotency.py -q`. Socket-only PostgreSQL creation and access need sandbox escalation in this environment. Configuration is /tmp/database-team-cluster.json; it contains only disposable socket/psql information. Stop via pg_ctl using that data directory after all cross-review tests finish.

## Permission-model limitation

Transaction/constraint suite executes as disposable cluster superuser, not a production service-role request. Stub service_role is a plain local role without Supabase BYPASSRLS or baseline platform grants. Thus positive worker authorization is not established. Independent security tests establish explicit anon/authenticated denial in these migrations, while deployed endpoint auth, tenancy, grants and RLS remain outside this local audit.
