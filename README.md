# Voice Agent Case

Voice Agent Case is a browser-based voice-agent management application backed by
Supabase and LiveKit. The Python agent can also run on its own without a
Supabase project; that mode does not include the management dashboard or its
saved agents and session history.

## System Overview

The repository has three runtime parts:

- `ui/` is the browser dashboard. It supports sign-in, agent and tool
  configuration, session views, and browser calls.
- `start.py` serves the dashboard on `http://127.0.0.1:8000` and provides its
  browser-safe Supabase URL and publishable key. It is a static-file server,
  not the application API.
- `supabase/` contains the database migrations, seed data, and Edge Functions.
  Functions authenticate dashboard requests, manage agents and tools, create
  LiveKit sessions, and process session, webhook, and observability data.
- `Livekit-Agents/` contains the LiveKit Python worker. It joins dispatched
  rooms, loads the agent configuration from job metadata (or uses its default
  configuration), and runs the voice pipeline.

### Browser Call Flow

1. A signed-in user selects an agent in the dashboard.
2. The dashboard calls the authenticated `livekit-session` Edge Function.
3. That function loads the agent and enabled tools, records a configuration
   snapshot, creates a LiveKit room and participant token, then dispatches the
   `Voice-Agent-Case` worker.
4. The browser connects to the room and publishes microphone audio. The worker
   runs the conversation and returns audio.
5. LiveKit webhooks update session lifecycle state. When configured, the worker
   also sends observability events to Supabase for session details and metrics.

The browser never receives the Supabase secret key or LiveKit API secret.
Keep those values in backend environment files or Edge Function secrets.

## Choose How to Run It

### Run the Agent Without Supabase

Use this path to try the voice agent directly from the terminal. It requires
LiveKit credentials, but does not require a Supabase account or project.

1. Install `uv` and the [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/).
2. Create or use a LiveKit project and obtain `LIVEKIT_URL`,
   `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.
3. From the repository root, configure and run the worker:

   ```console
   cd Livekit-Agents
   uv sync
   cp .env.example .env.local
   ```

   Put the three LiveKit values in `Livekit-Agents/.env.local`, then run:

   ```console
   lk agent console
   ```

   `lk agent console` starts an interactive terminal session. To run the worker
   for a LiveKit frontend instead, use `lk agent dev` and connect a frontend to
   the same LiveKit project.

In this mode, the worker uses its built-in default agent configuration.
Supabase-backed observability is skipped, and customer-bound collection calls
are unavailable because they require trusted session and customer records.
The repository's management dashboard and browser call flow also require
Supabase.

### Run the Full Dashboard and Browser Call Flow

This mode requires a Supabase project and a LiveKit project. Supabase Auth and
Edge Functions are part of the application, not optional local services.

1. Configure a Supabase project and apply the database migrations in
   `supabase/migrations/`. Follow [supabase/README.md](supabase/README.md) for
   migration ordering, collection seed data, webhooks, and database checks.
2. Configure Supabase Auth and create a user who can sign in to the dashboard.
3. Copy `supabase/.env.example` to `supabase/.env` and set at least
   `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY`.
   `SUPABASE_JWKS_URL` is optional. The dashboard uses only the URL and
   publishable key; backend worker integrations use the secret key.
4. Deploy the Supabase Edge Functions used by the dashboard from the repository
   root. The function directories are under `supabase/functions/`. Configure
   the required `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`
   function secrets for browser session creation and webhook verification.
5. In a terminal, start the LiveKit worker:

   ```console
   cd Livekit-Agents
   uv sync
   lk agent dev
   ```

   Make sure its `.env.local` contains the LiveKit credentials. For worker
   observability and customer-bound sessions, it also needs the Supabase URL
   and secret key; the worker can read these from `supabase/.env` at the
   repository root.
6. In another terminal at the repository root, start the dashboard:

   ```console
   python3 start.py
   ```

   Open `http://127.0.0.1:8000`, sign in, and start a call from an available
   agent. Allow microphone access when prompted.

The local dashboard server binds to `127.0.0.1`; it is intended for local
development, not direct public hosting.

## Tests

Run the Python worker tests from `Livekit-Agents/`:

```console
uv run pytest
```

LiveKit conversation simulations are defined in
[`Livekit-Agents/scenarios.yaml`](Livekit-Agents/scenarios.yaml) and can be run
with the LiveKit CLI:

```console
cd Livekit-Agents
lk agent simulate --scenarios scenarios.yaml
```

Simulations use LiveKit services and may incur inference usage. See
[Livekit-Agents/README.md](Livekit-Agents/README.md) for agent development,
frontend options, and deployment guidance.

## Repository Map

```text
start.py                 Local dashboard file server
ui/                      Browser dashboard
supabase/
  functions/             Authenticated APIs and LiveKit callbacks
  migrations/            Database schema and policy changes
  seeds/                 Optional development/test data
Livekit-Agents/
  src/                   Python LiveKit worker and integrations
  tests/                 Worker tests
  scenarios.yaml         LiveKit conversation simulations
```

Do not commit populated `.env` files, API keys, or secrets. See the
[LiveKit agent README](Livekit-Agents/README.md) and
[Supabase setup notes](supabase/README.md) for component-specific instructions.