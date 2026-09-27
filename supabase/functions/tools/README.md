# `tools`

Authenticated CRUD for the shared tool library and assignment replacement for agents.

## Endpoints

- `GET /tools` lists shared definitions.
- `GET /tools?agent_id=<id>` adds `assigned` and `configuration` fields.
- `POST /tools` creates a definition.
- `PATCH /tools?id=<id>` edits a definition or its enabled state.
- `DELETE /tools?id=<id>` disables a definition for reversible removal.
- `PUT /tools?agent_id=<id>` replaces the agent's assignments.

This slice stores the contract only. A later runtime slice will resolve `execution_key`, validate arguments against `input_schema`, execute the backend handler, and write tool telemetry.
