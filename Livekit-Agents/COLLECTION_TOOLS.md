# Collection tools

Implemented model tools:

- `verify_identity(date_of_birth, postal_code)`
- `evaluate_offer(amount_cents, payment_date)`
- `create_payment_commitment(proposal_id)`
- `request_callback(callback_at)`

All results contain only `tool_name`, `status`, `code`, `verified_user`, and `data`.
There is no escalation tool, `next_action`, or `retryable` field.

## Enable a customer-bound call

1. Apply `supabase/migrations/20260927000003_collection_tools.sql` after the
   customer migration. It also registers the four definitions in the tool library.
2. Deploy the changed `livekit-session` function and restart/deploy the worker.
3. Send the existing authenticated session endpoint its usual `agent_id` plus
   `customer_id`. Example body:

   ```json
   {"agent_id":"<agent UUID>","customer_id":"c011ec70-0000-4000-8000-000000000001"}
   ```

The endpoint binds the customer in a worker-only table and sets `collection_mode`
in server-generated dispatch metadata. Calls without a customer continue using
the existing generic assistant. No verification answers or account balances are
placed in dispatch metadata. The test-page selector is a separate UI change.

Collection mode currently uses the fixed four-tool workflow. The tools table is a
catalog; editable library schemas or agent assignments cannot replace backend
implementation or its payment rules.

## Trust and state

`collection.py` owns deterministic policy transitions. `collection_backend.py`
loads private state and uses PostgreSQL RPCs to atomically save the state,
business record, durable result and session audit event. Version checks reject
concurrent stale transitions; customer `updated_at` checks protect against an
account change between evaluation and saving. Policy is snapshotted in
`collection_sessions.state.policy` by the database, never from model arguments.
The draft policy is USD 800 minimum (capped at outstanding balance), 14 days,
and three identity attempts. Stages use Europe/Istanbul calendar dates.

`before_agent_response` runs inside the LLM node on every inference, including
post-tool replies. Before verification it restricts tools and reinforces the
identity instructions. Every payment operation checks verification again in the
backend. Invalid identity details and a missing customer use the same empty
`IDENTITY_NOT_VERIFIED` result. The third mismatch locks the session.

For eligible proposals the runtime speaks the exact amount/date with an explicit
confirmation question. Only completed, non-interrupted, error-free output creates
an internal review receipt. Commit requires a later actual customer message ID
and timestamp for the current proposal. Calling the commit tool is the model's
interpretation of agreement; runtime evidence does not prove language semantics.
Changes must be evaluated again. The backend allows one commitment in this MVP
session; later amendments need a separate flow. A commitment never changes balance.

No actual payments, credit reporting, interest calculation, automated callback
scheduler, or human transfers are implemented. Callback requests need an existing
registered phone number; the original six fixtures have no phone number.

## Failure handling and audit

Each SDK tool call ID is the operation's idempotency key. Transport failures get
one bounded recovery attempt using the same ID; each retry first looks up the
durable result. Requests time out after 4 seconds, with a 12-second overall
execution budget once the serialized operation starts. A final lookup attempts
to resolve uncertain writes. Unknown outcomes return `OUTCOME_UNKNOWN`, not a
false failure or success. Session verification is preserved across outages.

`collection_operations` stores durable receipts. `session_events` records
`collection.tool_result` with result code, policy version and sanitized arguments.
Application logs record attempt IDs, failures and duration without input values.
Existing SDK observability stores tool execution events; structured technical
errors are classified as failures and policy rejections as completed executions.
Verification tool arguments and pre-verification application transcript events
are redacted. Avoid enabling raw SDK/provider content tracing or transcript
exports for real identity data; those are separate from this application logger.

## Validation

```sh
cd Livekit-Agents
uv run pytest
RUN_COLLECTION_MODEL_TEST=1 uv run pytest tests/test_collection_runtime.py -k real_model
```

The opt-in test loads `.env.local` and uses LiveKit Inference with synthetic account
data and an in-memory RPC transport; it never writes to the remote database.
Deterministic tests cover rule boundaries, confirmation ordering, model-tool
plumbing, lost-response recovery and log redaction. The ordinary-language test
covers verification, claimed manager override, a correction mixed with agreement,
and final confirmation. Run `supabase/manual-checks/collection-tools.sql` against
an isolated database for transaction, idempotency, permissions and rollback tests.
It rolls back its own fixtures. Real microphone/audio interruption testing remains
necessary before production voice deployment.
