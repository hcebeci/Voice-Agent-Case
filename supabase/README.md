# Supabase foundation

This directory contains the database foundation for the single-organization MVP.

## Database setup

For a new project, open Supabase **SQL Editor** and run these files one at a
time, in this order. Paths are relative to this directory:

1. `migrations/20260925_000001_initial_schema.sql`
2. `manual-migrations/20260925_000002_agent_change_history.sql`
3. `migrations/20260926000001_livekit_webhook_events.sql`
4. `migrations/20260926000002_observability_event_contract.sql`
5. `migrations/20260926000003_observability_processing_state.sql`
6. `migrations/20260927000001_collection_customers.sql`
7. `migrations/20260927000002_agent_tts_settings.sql`
8. `migrations/20260927000003_collection_tools.sql`
9. `migrations/20260928000001_observability_upsert_indexes.sql`

The manual audit-history migration is outside the CLI migration directory and
must be included explicitly. For an existing project, apply only outstanding
migrations using its migration history; some files are not safe to rerun.

For customer-bound tests, also execute `seeds/collection_customers.sql` and
validate with `manual-checks/collection-customers.sql`. The collection-tool
migration registers four supported tools; no migration creates an agent.
Create your first agent through the dashboard after signing in.

## Collection customer database

Apply `migrations/20260927000001_collection_customers.sql` after the existing
foundation, then execute `seeds/collection_customers.sql`. Validate with
`manual-checks/collection-customers.sql`. The seed inserts missing account
references only: rerunning it never resets customers or deletes call history.

The six named records are fictional test records. DOBs, postal codes,
balances, interest, and credit-reporting statuses are invented. Phone numbers
are null until an authorized test destination is supplied. Every account uses
`Europe/Istanbul`; currency is USD. Balances already
include the stored interest component. No interest calculation, payment, or
credit-bureau submission happens when these records are created.

| Account | Customer | Scenario on 2026-09-27 | Due date | Balance (USD) |
| --- | --- | --- | --- | --- |
| DEMO-001 | Alper Araras | early (12 days) | 2026-09-15 | 2,000 |
| DEMO-002 | Alptuğ Tekin | reminder | 2026-10-04 | 1,200 |
| DEMO-003 | Hasancan cebeci | early (25 days) | 2026-09-02 | 1,500 |
| DEMO-004 | Hasancan Çelebi | medium (45 days) | 2026-08-13 | 3,000 |
| DEMO-005 | Ömer Can Sökmen | reminder | 2026-09-30 | 600 |
| DEMO-006 | Ömer Can cebeci | medium (60 days) | 2026-07-29 | 2,500 |

`customer_collection_context` calculates live stages from the current Istanbul
date: through the due date = reminder, 1-30 days late = early, 31+ = medium.
Records naturally age into later stages. Reproducible tests should call
`collection_stage(payment_due_date, DATE '2026-09-27')` rather than change dates
or clear existing data. The due date is the original account due date, not a
future promise-to-pay date.

Both the table and context view are backend-only (no anonymous or authenticated
browser grants). The view excludes verification answers. Collection tools enforce session
verification before returning debt details and redact DOB and postal-code inputs
from tool logs. Policy `collection-demo-v1` identifies
the collection procedure implemented by the worker and database RPCs.

The customer migration creates the account foundation. The subsequent
`migrations/20260927000003_collection_tools.sql` adds worker-only collection
sessions, operation receipts, payment commitments, callback requests, atomic RPCs,
and the four tool definitions. See `../Livekit-Agents/COLLECTION_TOOLS.md` for
activation, policy, privacy, retries, and testing instructions. The new tool
migration must be applied separately before enabling customer-bound calls.

## Values needed locally

Copy `.env.example` to the backend environment file used by the application and
fill in the values from **Project Settings → API** in Supabase.

The publishable key may be used by an authenticated browser client.
The secret key bypasses row-level security and must only be used by a trusted
backend process. Do not commit either populated environment file.

## Runtime status rules

The UI should calculate the agent badge from the database:

- `offline`: `agents.archived_at` is set
- `active`: at least one related session has status `connecting` or `active`
- `sleeping`: the agent is not archived and has no active sessions

## Agent history

The database records `created`, `updated`, `archived`, and `restored` events in
`agent_change_events`. Each event stores the actor, timestamp, changed fields,
previous values, and new values. The current API archives agents instead of
hard-deleting them, so history remains available.

## LiveKit lifecycle webhooks

The `livekit-webhook` Edge Function verifies signed LiveKit callbacks, stores
each event once in `livekit_webhook_events`, and updates the matching session.
Deploy it with:

```bash
npx supabase functions deploy livekit-webhook
```

In LiveKit Cloud, open **Settings → Webhooks**, create a webhook with this URL,
and select the same API key stored in the Supabase Edge Function secrets:

```text
https://<project-ref>.supabase.co/functions/v1/livekit-webhook
```

Enable room and participant lifecycle events, especially `room_started`,
`participant_joined`, `participant_connection_aborted`, `participant_left`,
and `room_finished`. New browser rooms use a 20-second departure timeout, so
after the last participant leaves, the room normally finishes within about
20–35 seconds (the remaining variation comes from the dashboard's 15-second
polling interval).

## Worker observability ingestion

The LiveKit worker sends turn, trace, usage, and tool events to the internal
`session-observability` function. The worker loads `SUPABASE_URL` and
`SUPABASE_SECRET_KEY` from the private `supabase/.env` file. The secret key is
used only by the backend worker and must never be placed in `ui/config.js`.

Stage 2 read-only verification queries are in
`supabase/manual-checks/stage-2-observability.sql`. Run them in the Supabase SQL
Editor after a test call to inspect receipt duplicates, failed materialization,
turn coverage, usage totals, latency aggregates, and stale sessions.

## Agent metrics

The Agent Metric Page uses the authenticated `agent-metrics` Edge Function. Deploy
it from the repository root after changing its query or aggregation logic:

```bash
npx supabase functions deploy agent-metrics
```
