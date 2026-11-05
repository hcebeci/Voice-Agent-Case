# Idempotency audit — 4 November 2026

This is a code and executable-test audit. No application behavior, production records, or deployed schema were changed. Database write tests ran against an isolated PostgreSQL instance with no TCP listener, initialized from all eight repository migrations. Local roles and an auth.users stub supplied only the schema dependencies normally provided by Supabase.

## Findings

| Path | Mechanism | Verified behavior and boundary |
| --- | --- | --- |
| Collection tool HTTP retry | Runtime tool call ID becomes request_id; receipt key is (session_id, request_id) | Reusing a key returns the recorded result instead of applying the effect again. |
| Lost response after collection commit | Worker re-reads collection_snapshot with the same request ID | Actual SQL committed one callback; simulated HTTP ReadTimeout after that commit recovered its receipt. One write attempt, one callback, one operation receipt. |
| Concurrent retries | collection_commit locks session and collection-session rows; checks recorded receipt before version validation | Twelve concurrent calls of the same request to actual PostgreSQL produced one callback and one operation receipt. |
| Payment commitments | State tracks existing commitment by proposal ID; database has UNIQUE(proposal_id) | A second call with a different tool-call ID but the same proposal returned COMMITMENT_ALREADY_EXISTS and left one commitment. This is per proposal, not general deduplication of matching customer/date/amount across new proposals or sessions. |
| Callback repeated with a new tool-call ID | Only request-ID receipt replay; each new successful callback transition generates a fresh UUID | Same arguments under two request IDs produced two pending callback rows. A new key is treated as a new operation. If this is a retry of one logical user action, the current mechanism does not prevent duplication. Intentionally separate actions must remain distinguishable. |
| Session creation replay | Handler generates crypto.randomUUID() each invocation; no idempotency-key lookup | Executing the actual createBrowserSession handler twice with identical bodies and an identical Idempotency-Key header produced two session IDs and two mocked agent dispatches. External SDK services and database boundaries were mocked; no real rooms were opened. The browser's in-memory callStarting/liveSession guards are not durable backend idempotency. |
| Worker telemetry HTTP retries | One event UUID is created outside the three-attempt HTTP retry loop | Three requests after simulated lost responses retained one event ID. Database rejects duplicate (source, source_event_id) inserts. This covers retry of that event, not re-emission as a new event with a new ID. |
| Webhook event receipt | livekit_webhook_events.event_id is a primary key; already-processed receipts are skipped | Code has deduplication, but the downstream session_events upsert has a schema incompatibility described below. |

## Webhook upsert incompatibility

The webhook appends to session_events using ON CONFLICT(source, source_event_id), without a predicate. The repository defines that table's unique index as partial: WHERE source_event_id IS NOT NULL. A fresh database built from all migrations rejects the webhook's equivalent INSERT ... ON CONFLICT statement with:

```text
there is no unique or exclusion constraint matching the ON CONFLICT specification
```

Migration 20260928000001 fixes this inference problem for session_traces and tool_calls, but does not change session_events. This is a reproducible processing/reliability gap, not a demonstrated duplicate side effect. Deployed indexes were not inspected, so this audit does not claim the live database necessarily has the same index definitions.

## Code locations

- `Livekit-Agents/src/collection_agent.py`: CollectionTools.invoke supplies context.function_call.call_id.
- `Livekit-Agents/src/collection_backend.py`: execute reuses request_id, reconciles lost responses, and returns OUTCOME_UNKNOWN when a write may have started but cannot be confirmed.
- `Livekit-Agents/src/collection.py`: create_payment_commitment checks state.commitments by proposal; request_callback generates a new request UUID for every new successful operation.
- `supabase/migrations/20260927000003_collection_tools.sql`: collection_operations primary key, payment proposal uniqueness, collection_snapshot receipt lookup, and transactional collection_commit locking/write/receipt/audit sequence.
- `Livekit-Agents/src/observability.py`: _send_with_retries constructs event_id before its retry loop.
- `supabase/functions/livekit-session/index.ts`: createBrowserSession has no request-idempotency record or replay path.
- `supabase/functions/livekit-webhook/index.ts`: event receipt deduplication and session_events upsert.
- `supabase/migrations/20260926000002_observability_event_contract.sql`: session_events partial unique index.

## Validation

- Existing collection, collection-runtime, and observability tests: 25 passed, 1 skipped.
- Added temporary diagnostic suite: 6 passed, 2 strict expected failures documenting callback/new-key duplication and webhook upsert incompatibility.
- Separate session-handler replay reproduction: expected one session; observed two sessions and two dispatch calls, causing the safety assertion to fail.
- No actual payment was collected: payment_commitments records promises rather than transfers.

Temporary reproductions: `/tmp/test_idempotency_audit.py`, `/tmp/test-session-idempotency-audit.mts`, and `/tmp/prepare_idempotency_audit.py`. The SQL reproduction requires the disposable cluster initialized by the preparation script. The instance was stopped after the audit; its disposable data and scripts remain available for review.

## Interpretation

The system has real idempotency, but its guarantees are scoped to particular identities. A retry must preserve the original logical operation identity. Matching payloads alone do not establish that two operations are duplicates. Durable unique constraints and atomic receipts protect already-identified operations; they cannot decide whether two newly generated IDs represent one user intent.

The system cannot currently be certified duplicate-free across session creation and newly identified callbacks. No fix is included in this audit.
