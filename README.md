# Voice Agent Case

A browser application for configuring voice agents, talking to them through
LiveKit, and reviewing their sessions. Supabase provides authentication,
persistence, and the backend APIs; a Python worker runs the voice pipeline.

## What you can do

- Create and edit agents with saved instructions, model, language, TTS model,
  and enabled tools.
- Start browser voice calls and review session history, transcripts, tool calls,
  latency, and usage metrics.
- Test customer-bound collection conversations with fictional customer records,
  identity verification, payment commitments, and callback requests.

Collection tools save commitments and callback requests. They do not process
payments, schedule callbacks, or dial telephone numbers. Both call directions
in the dashboard use browser audio.

## Architecture

| Component | Responsibility |
| --- | --- |
| `ui/` | Browser dashboard using Supabase Auth and the LiveKit client SDK. |
| `start.py` | Local static-file server and browser configuration endpoint. |
| `supabase/` | PostgreSQL schema, access policies, Edge Functions, and seed data. |
| `Livekit-Agents/` | Python worker for speech recognition, LLM responses, speech synthesis, and tool execution. |

For a browser call, the authenticated `livekit-session` function loads the saved
agent and enabled tools, snapshots the configuration, creates a room and browser
token, and dispatches the worker registered as `Voice-Agent-Case`. The browser
and worker exchange audio through LiveKit. Webhooks update session lifecycle
state; the worker sends transcript, tool, and usage events to Supabase.

The browser receives the Supabase URL and publishable key. Backend processes
hold the Supabase secret key and LiveKit API secret. The database currently uses
a single shared organization: authenticated users share the application data.

## Run the full application

After completing the setup below, use [Start the local web server](#3-start-the-local-web-server)
and [Start the voice worker](#4-start-the-voice-worker) each time you run the application.

The dashboard and worker run locally; this setup uses hosted Supabase and
LiveKit Cloud services. The supplied voice pipeline uses LiveKit Inference.

### Prerequisites

- Python 3.10–3.14 and [uv](https://docs.astral.sh/uv/getting-started/installation/).
- The [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) (`lk`).
- A LiveKit Cloud project with Inference access and its URL, API key, and API secret.
- A Supabase project and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).
  The commands below use `npx`, which requires Node.js and npm.
- A browser with microphone access and an internet connection.

Clone the repository and run the following setup from its root:

```console
git clone https://github.com/hcebeci/Voice-Agent-Case.git
cd Voice-Agent-Case
cp supabase/.env.example supabase/.env
cp Livekit-Agents/.env.example Livekit-Agents/.env.local
```

If you already have the repository or populated environment files, use those.

### 1. Configure credentials

| File | Required values | Used by |
| --- | --- | --- |
| `supabase/.env` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | Local dashboard configuration and worker integrations. |
| `Livekit-Agents/.env.local` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Python worker. |

`SUPABASE_JWKS_URL` is optional. Keep populated environment files private;
`start.py` exposes only the URL and publishable key to the browser.

### 2. Set up Supabase

Apply the SQL files in the order listed in the
[database setup guide](supabase/README.md#database-setup). That includes the
manual agent-history migration and the observability index migration.
For customer-bound tests, also run `supabase/seeds/collection_customers.sql`.

In Supabase Auth, create a confirmed email/password user. The dashboard has a
sign-in form; it does not create user accounts.

Authenticate the CLI, link your project, and deploy all Edge Functions from the
repository root. Replace `<project-ref>` with your Supabase project reference:

```console
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase functions deploy
```

This deploys `agents`, `tools`, `dashboard`, `sessions`, `agent-metrics`,
`test-cases`, `livekit-session`, `livekit-webhook`, and `session-observability`.
The deployment uses the per-function authentication settings in
`supabase/config.toml`. See the [Supabase deployment guide](https://supabase.com/docs/guides/functions/deploy)
for CLI details.

In Supabase **Edge Functions → Secrets**, set `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
and `LIVEKIT_API_SECRET` to the same project credentials as the worker.
Local environment files do not configure deployed function secrets.

In LiveKit Cloud, configure a webhook pointing to:

```text
https://<project-ref>.supabase.co/functions/v1/livekit-webhook
```

Use the same LiveKit API key configured in the Edge Function secrets and enable
room and participant lifecycle events. See the
[webhook setup notes](supabase/README.md#livekit-lifecycle-webhooks) for the event list.
This is needed for session lifecycle updates, including finalization after a call.

### 3. Start the local web server

Open a terminal in the repository root, the directory containing `start.py`,
and run:

```console
python3 start.py
```

This starts the dashboard's HTTP server using Python's standard library;
it needs no separate dependency installation or frontend build. On startup,
it prints:

```text
Agent manager available at http://127.0.0.1:8000
```

Keep this terminal running and open <http://127.0.0.1:8000> in your browser.
The server serves `ui/` and generates `/config.js` from `supabase/.env`.
Use `start.py` to serve the dashboard so it receives this runtime configuration.

### 4. Start the voice worker

Open a second terminal in the repository root and run:

```console
cd Livekit-Agents
uv sync
lk agent dev
```

Keep this terminal running too. The web server serves the dashboard; the worker
handles voice conversations. Supabase APIs run as the deployed Edge Functions,
and LiveKit runs in your Cloud project. This setup does not require another
local API server or a local LiveKit server.

### 5. Verify the application

Open <http://127.0.0.1:8000> and sign in. Create an agent, save its instructions
and model settings, then choose **Start call** and allow microphone access.
A normal conversation can run without a customer or assigned collection tools.

For customer-bound conversations, assign the supported tools to the agent and
select a seeded customer in **Tests**. Follow the
[collection tool guide](Livekit-Agents/COLLECTION_TOOLS.md) for prerequisites
and expected behavior.

After ending a call, check its transcript and metrics in the session history.
If a call does not connect, check that the worker and Edge Functions use the
same LiveKit project and that the worker is registered as `Voice-Agent-Case`.
For missing session data, check webhook delivery and the worker's Supabase
credentials.

Stop the local web server and worker with **Ctrl+C** in their respective
terminals. To start them again, repeat steps 3 and 4. If Python reports
`Address already in use`, stop the process already listening on port 8000
before restarting the server.

The local dashboard server binds to `127.0.0.1:8000` and is intended for local
development.

## Run only the voice agent

This path needs a LiveKit Cloud project, Python, uv, and the LiveKit CLI. It
works without Supabase or the dashboard.

From the repository root:

```console
cd Livekit-Agents
uv sync
cp .env.example .env.local
```

Fill in `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in
`.env.local`, then start an interactive terminal conversation:

```console
lk agent console
```

The worker uses its built-in assistant configuration when no job configuration
is supplied. Without Supabase credentials, application session persistence and
customer tools are unavailable. For a custom LiveKit frontend, run
`lk agent dev` and explicitly dispatch the agent named `Voice-Agent-Case`.

## Validation

Run the Python worker tests:

```console
cd Livekit-Agents
uv run pytest
```

Run the JavaScript tests from the repository root with Node.js:

```console
node --test ui/tests/*.test.cjs supabase/functions/*/*.test.mjs
```

Optional conversation simulations, from `Livekit-Agents/`:

```console
lk agent simulate --scenarios scenarios.yaml
```

These scenarios exercise the default assistant, rather than the full dashboard
or customer workflow. They use LiveKit Cloud and may incur inference charges.

## Further reading

- [Worker setup and source map](Livekit-Agents/README.md)
- [Database setup and backend checks](supabase/README.md)
- [Collection tools, state transitions, and validation](Livekit-Agents/COLLECTION_TOOLS.md)
