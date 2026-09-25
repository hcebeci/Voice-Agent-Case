# Supabase foundation

This directory contains the database foundation for the single-organization MVP.

## Run the first migration

1. Open the Supabase dashboard for the project.
2. Open **SQL Editor** and create a new query.
3. Copy the contents of `migrations/20260925_000001_initial_schema.sql` into the query.
4. Run the query once.
5. Open **Table Editor** and confirm the tables are present.

After the first migration succeeds, run the migrations in numerical order. The
second migration, `20260925_000002_agent_change_history.sql`, adds the append-only
agent history table and trigger.

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
