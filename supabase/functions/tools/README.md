# `tools`

Authenticated CRUD for the shared tool library and assignment replacement for agents.

## Endpoints

- `GET /tools` lists shared definitions.
- `GET /tools?agent_id=<id>` adds `assigned` and `configuration` fields.
- `POST /tools` creates a definition.
- `PATCH /tools?id=<id>` edits a definition or its enabled state.
- `DELETE /tools?id=<id>` disables a definition for reversible removal.
- `PUT /tools?agent_id=<id>` replaces the agent's assignments.

Paths above are relative to `/functions/v1`. Every request requires a Supabase
user access token; database access uses that user's row-level security policies.

Assignment requests use an `assignments` array, for example:

```json
{"assignments":[{"tool_id":"<tool UUID>","configuration":{}}]}
```

`PUT` replaces the complete assignment set; an empty array removes all
assignments. Only enabled tools can be assigned.

This API stores tool definitions and assignments. During call setup,
`livekit-session` resolves enabled assignments and rejects unsupported execution
keys or missing prerequisites. The Python worker executes the four supported
[collection tools](../../../Livekit-Agents/COLLECTION_TOOLS.md) and records
their outcomes. Creating a definition here does not implement a new tool.
