# Agents Edge Function

This authenticated endpoint is the first backend slice for the agent editor.

## Supported requests

- `GET /functions/v1/agents` lists saved agents.
- `GET /functions/v1/agents?id=<agent-id>` returns one saved agent.
- `GET /functions/v1/agents?id=<agent-id>&include=history` returns the agent and its change history.
- `POST /functions/v1/agents` creates a saved agent.
- `PATCH /functions/v1/agents?id=<agent-id>` updates saved fields or archives/restores an agent.
- `DELETE /functions/v1/agents?id=<agent-id>` archives the agent and records an `archived` event; it does not hard-delete data.

Every request requires a Supabase user access token. The function uses the
request user's Supabase context, so database row-level security remains active.

The endpoint intentionally does not calculate `active`, `sleeping`, or `offline`.
Those states require session data and will be derived by the application query
once browser sessions are connected.
