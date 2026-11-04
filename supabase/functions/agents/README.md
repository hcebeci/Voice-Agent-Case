# Agents Edge Function

Manage saved agent configurations and their change history.

## Supported requests

- `GET /functions/v1/agents` lists saved agents.
- `GET /functions/v1/agents?id=<agent-id>` returns one saved agent.
- `GET /functions/v1/agents?id=<agent-id>&include=history` returns the agent and its change history.
- `POST /functions/v1/agents` creates a saved agent.
- `PATCH /functions/v1/agents?id=<agent-id>` updates saved fields or archives/restores an agent.
- `DELETE /functions/v1/agents?id=<agent-id>` archives the agent and records an `archived` event; it does not hard-delete data.

Every request requires a Supabase user access token. The function uses the
request user's Supabase context, so database row-level security remains active.

Read responses include `runtime_status` and `active_session_count`. An archived
agent is `offline`; otherwise it is `active` when a session is connecting or
active, and `sleeping` when there are no such sessions. These values describe
saved session state, not worker availability.
