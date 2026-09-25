# Supabase foundation

This directory contains the database foundation for the single-organization MVP.

## Run the first migration

1. Open the Supabase dashboard for the project.
2. Open **SQL Editor** and create a new query.
3. Copy the contents of `migrations/20260925_000001_initial_schema.sql` into the query.
4. Run the query once.
5. Open **Table Editor** and confirm the tables are present.

After the first migration succeeds, run the manually applied audit migration in
`manual-migrations/20260925_000002_agent_change_history.sql`, then apply
`migrations/20260926000001_livekit_webhook_events.sql` and
`migrations/20260926000002_observability_event_contract.sql` and
`migrations/20260926000003_observability_processing_state.sql`. New migrations
use full timestamps so Supabase can track each version uniquely.

The migration is safe to run again because it uses `if not exists` for tables and
replaces its policies and triggers. It does not seed any tools or agents.

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
