# Voice agent worker

The Python worker for Voice Agent Case. It connects to LiveKit Cloud as
`Voice-Agent-Case`, receives the selected agent configuration through dispatch
metadata, and runs speech recognition, LLM responses, speech synthesis, and
supported tools.

For dashboard setup, database migrations, function deployment, and browser calls,
start with the [application README](../README.md#run-the-full-application).

## Local setup

Requires Python 3.10–3.14, [uv](https://docs.astral.sh/uv/getting-started/installation/),
the [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/), and a LiveKit Cloud
project with Inference access.

From this directory:

```console
uv sync
cp .env.example .env.local
```

Fill in the three values in `.env.local`:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

For dashboard calls, observability, and customer tools, also configure
`SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `../supabase/.env`. The worker loads
that file and `.env.local` without overriding values already in the environment.
Keep all populated environment files private.

## Run

Talk to the default assistant in the terminal:

```console
uv run --env-file .env.local lk agent console
```

Run the worker with source reload for dashboard or custom frontend calls:

```console
uv run --env-file .env.local lk agent dev
```

Passing `.env.local` through uv makes its LiveKit credentials available to the
CLI before project resolution, avoiding the existing deployment reference in
`livekit.toml`. Clear stale exported LiveKit credentials when switching projects.
For full database and API bootstrap, follow the [setup runbook](../docs/SETUP.md).

Custom frontends must explicitly dispatch `Voice-Agent-Case`. The dashboard's
`livekit-session` function handles this automatically. Browser calls require a
valid saved configuration; they do not fall back to the default assistant.
Console sessions without job metadata use the built-in configuration.

See the [LiveKit agent CLI reference](https://docs.livekit.io/reference/developer-tools/livekit-cli/agent/)
for command options.

## Source map

| File | Responsibility |
| --- | --- |
| `src/agent.py` | Worker entrypoint, configuration, voice pipeline, and session events. |
| `src/collection_agent.py` | Conversation guards and supported model tools. |
| `src/collection.py` | Collection policy and deterministic state transitions. |
| `src/collection_backend.py` | Private customer state, database RPCs, and operation recovery. |
| `src/observability.py` | Turn tracking and event delivery to Supabase. |

Creating a tool definition in the dashboard does not implement its behavior.
The worker executes supported implementations selected by their execution keys.
See [collection tools](COLLECTION_TOOLS.md) for activation, confirmation rules,
state persistence, and failure handling.

## Validation

```console
uv run pytest
```

Optional default-assistant conversation simulations:

```console
uv run --env-file .env.local lk agent simulate --scenarios scenarios.yaml
```

Simulations use LiveKit Cloud and may incur inference charges. They do not cover
the complete dashboard or customer workflow. Additional collection validation
is described in [COLLECTION_TOOLS.md](COLLECTION_TOOLS.md#validation).

## Deployment notes

The [Dockerfile](Dockerfile) builds the worker and starts `src/agent.py start`.
A deployed worker needs the three LiveKit credentials above. Supabase-backed
sessions additionally need `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the worker's
deployment secrets; repository-local environment files are not deployed.
Keep the registered worker name aligned with the session API's dispatch name.
See the [LiveKit deployment guide](https://docs.livekit.io/deploy/agents/) for
hosting instructions.
