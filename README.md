# Voice Agent Case

Configure voice agents, talk to them in your browser, and review how each
conversation performed. The application combines a web dashboard, Supabase
for authentication and saved data, and a Python worker connected to LiveKit Cloud.

Start with [project setup](#run-the-full-application), jump to
[server startup](#3-start-the-local-web-server) if already configured, or
[try the worker alone](#run-only-the-voice-agent).

## Application sections

| Section | What you can do |
| --- | --- |
| **Dashboard** | See daily activity, agent status, a session timeline, and recent calls. Open an agent to view its performance. |
| **Agents** | Create, search, edit, archive, and reactivate agents. Set instructions, model, language, text-to-speech model, and assigned tools; start browser calls. |
| **Tools** | Create and edit shared tool definitions, enable or disable them, and make them available for agent assignment. |
| **Tests** | Select an agent and fictional customer, choose who speaks first, and role-play a browser call. |
| **Settings** | Navigation placeholder; a settings page is not implemented. |

Session history and agent metrics are reached through the dashboard or agent
cards. **Tests** is for interactive conversations; [automated tests](#validation)
run separately from the terminal.

## Core concepts

| Concept | Meaning in this application |
| --- | --- |
| **Agent** | A saved configuration: its purpose, conversation instructions, model, language, speech output, and tools. The worker runs that configuration. |
| **Voice pipeline** | Speech-to-text (STT) transcribes what you say, a language model (LLM) decides the response and tool requests, and text-to-speech (TTS) speaks the response. English and Turkish are supported. |
| **Session** | One browser call. Its configuration is copied when it starts, so later agent edits do not rewrite that call's saved configuration. |
| **Tool** | A capability the agent can request. Its execution key identifies a Python implementation; creating a definition in the dashboard does not create executable behavior. |
| **Mock customer** | A fictional account record with verification details and a balance. A human plays this customer; the record is not another AI agent. |
| **Worker** | The Python process that joins a LiveKit room and runs the conversation. Keep it running while making calls. |

Agent badges describe saved session state: **active** means at least one
connecting or active session; **sleeping** means no such sessions; **offline**
means archived. These badges do not check whether a worker process is online.
Archiving prevents new calls while retaining saved history; reactivation makes
the agent available again.

## Architecture

| Component | Responsibility |
| --- | --- |
| `ui/` | Browser dashboard using Supabase Auth and the LiveKit client SDK. |
| `start.py` | Local HTTP server for dashboard files and browser configuration. |
| `supabase/` | PostgreSQL database, access policies, Edge Functions, and fictional customer seed data. Edge Functions are the application's hosted APIs. |
| `Livekit-Agents/` | Python voice worker, collection-tool implementations, and session event delivery. |

When you start a call:

1. The signed-in browser asks the `livekit-session` API to create it.
2. The API loads the saved agent and tools, copies the configuration, creates a
   LiveKit room and browser token, and dispatches the `Voice-Agent-Case` worker.
3. The browser and worker exchange audio through LiveKit. Customer-bound tools
   read and write private account state through the backend.
4. The worker sends conversation events to Supabase. LiveKit sends webhooks
   (signed HTTP notifications) to update session lifecycle state.

The browser receives the Supabase URL and publishable key. Backend processes
hold the Supabase secret key and LiveKit API secret. Authenticated users share
one organization's data; separate customer workspaces are not implemented.

## Run the full application

The dashboard and worker run locally; the database, APIs, audio rooms, and model
inference use hosted Supabase and LiveKit Cloud services.

### 1. Prepare accounts and tools

- Python 3.10–3.14 and [uv](https://docs.astral.sh/uv/getting-started/installation/).
- The [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) (`lk`).
- Node.js and npm for the Supabase CLI commands and JavaScript tests.
- Your own Supabase project and LiveKit Cloud project with Inference access.
- A browser, microphone, and internet connection.

Clone the repository:

```console
git clone https://github.com/hcebeci/Voice-Agent-Case.git
cd Voice-Agent-Case
```

### 2. Configure the project once

Follow the [complete setup runbook](docs/SETUP.md). It covers local credentials,
ordered database migrations, fictional customers, a sign-in account, Edge
Functions, LiveKit secrets and webhooks, and the first agent and tool assignments.
It includes commands and checks for an engineer or an agent performing setup.

The resulting local configuration is:

| File | Required values |
| --- | --- |
| `supabase/.env` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` |
| `Livekit-Agents/.env.local` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |

Account access, project credentials, and a database connection are required for
provisioning. An agent can follow the runbook with those inputs; they are not
included in the repository. Keep populated environment files private.

### 3. Start the local web server

In a terminal at the repository root, run:

```console
python3 start.py
```

It prints:

```text
Agent manager available at http://127.0.0.1:8000
```

Keep the terminal running. This server uses Python's standard library; no
frontend build is required. It serves `ui/` and generates `/config.js` from
`supabase/.env`, exposing only the URL and publishable key to the browser.

### 4. Start the voice worker

In a second terminal, from the repository root:

```console
cd Livekit-Agents
uv sync
uv run --env-file .env.local lk agent dev
```

The `--env-file` option gives the CLI your project credentials before it
resolves a LiveKit project. This avoids using the deployment reference saved in
the repository's `livekit.toml`. Clear stale exported LiveKit credentials if you
previously used another project.

Keep this terminal running too. The web server serves the dashboard and the
worker handles voice conversations. Supabase APIs are deployed Edge Functions;
this setup does not require another local API server or local LiveKit server.

### 5. Make your first call

Open <http://127.0.0.1:8000> and sign in with the account created during setup.
Under **Agents**, create an agent with instructions such as “You are a concise,
helpful voice assistant.” Choose its model, language, and TTS model, then save.
Choose **Start call**, continue without a customer account, and allow microphone
access. You speak first. No collection tools are needed for this general call.

To stop the web server and worker, press **Ctrl+C** in each terminal. To run the
application again, repeat steps 3 and 4. The web server listens only on
`127.0.0.1:8000` and is intended for local development.

## Test a call with a mock customer

Mock customers are records you role-play. They do not answer automatically,
and neither call direction dials a phone number.

1. Complete setup, including the fictional customer seed and collection tools.
2. Create or edit an agent with collection instructions and assign the tools
   listed below. Selecting a customer does not set the agent's persona or tools.
3. Open **Tests**, choose an **Agent** and **Customer to play**, and review the
   displayed customer information and saved agent configuration.
4. Choose **Agent calls user** (the agent speaks first) or **User calls agent**
   (you speak first).
5. Click **Start test call**, allow microphone access, and speak as the customer.
   Use the displayed date of birth and postal code when asked to verify identity.
6. End the call and choose **View last test call** to review the results.

A starting instruction for the agent:

> You help customers discuss their outstanding account. Verify identity before
> discussing account details. Use the available tools to evaluate payment
> proposals. Let the offer tool present the exact terms, then wait for explicit
> customer agreement before saving a commitment. Describe only outcomes confirmed by the tools.

### Supported collection tools

| Tool | Function |
| --- | --- |
| `verify_identity` | Check the selected customer's birth date and postal code; repeated mismatches lock verification for the session. |
| `evaluate_offer` | Check a proposed payment amount and date against account policy; it does not save a commitment. |
| `create_payment_commitment` | Save a confirmed, eligible proposal as a promise to pay; it does not collect money or reduce the balance. |
| `request_callback` | Save a callback request for a future time using the customer's registered phone number. |

Enable tools in **Tools**, then assign them in the agent editor. A globally
disabled tool is excluded from new calls even if previously assigned. Library
names, descriptions, and input schemas document definitions; runtime arguments
and behavior come from the worker implementation.

Assign the first three tools for a payment conversation. Payment tools require
`verify_identity`, and saving a commitment also requires `evaluate_offer`.
The callback tool is optional. Seeded customers have no phone numbers, so
callback requests remain unavailable until an authorized test number is added.

Collection stages are calculated from due dates and change as time passes.
See the [collection guide](Livekit-Agents/COLLECTION_TOOLS.md) for policy limits,
confirmation, retries, and saved records. No payment processing, telephone dialing,
callback scheduler, credit reporting, or human transfer is implemented.

## Review a conversation

From **Dashboard**, choose **See all** in recent sessions, then open a session.
Choose an agent's **Metrics** action to review aggregate performance and recent
sessions for that agent.

| View or metric | What it means |
| --- | --- |
| **Transcript** | Timestamped text from conversation turns; this is not an audio recording. |
| **Logs** | Session events with occurrence and receipt times, useful for investigating lifecycle and tool outcomes. |
| **Traces** | A processing timeline showing speech, model, and tool activity; select entries to inspect details. |
| **Input/output tokens** | Units of text processed and generated by the language model; these are usage counts, not an invoice. |
| **Response latency** | Time from the user stopping speech to the agent's first audio, including tool work. |
| **p50 / p95** | The median and 95th-percentile duration across recorded measurements. Speaking duration and response latency measure different things. |

Session details depend on worker event delivery and webhooks. Missing values can
mean a measurement has not arrived; they do not necessarily mean zero usage.

## Run only the voice agent

This needs Python, uv, the LiveKit CLI, and your own LiveKit Cloud project with
Inference access. From the repository root:

```console
cd Livekit-Agents
uv sync
cp .env.example .env.local
```

Skip the copy if the file is already configured. Fill in the three LiveKit
values, then run:

```console
uv run --env-file .env.local lk agent console
```

Without job metadata, the worker uses its built-in assistant configuration.
Without Supabase credentials, application history and customer tools are
unavailable. For a custom frontend, run `uv run --env-file .env.local lk agent dev` and
explicitly dispatch the worker named `Voice-Agent-Case`.

## Validation

Python worker tests, from `Livekit-Agents/`:

```console
uv run pytest
```

JavaScript tests, from the repository root:

```console
node --test ui/tests/*.test.cjs supabase/functions/*/*.test.mjs
```

Optional default-assistant simulations, from `Livekit-Agents/`:

```console
uv run --env-file .env.local lk agent simulate --scenarios scenarios.yaml
```

Simulations use LiveKit Cloud and may incur inference charges. They exercise the
default assistant, rather than the full dashboard or customer workflow.

## Troubleshooting and reference

| Symptom | First check |
| --- | --- |
| Server reports `Address already in use` | Stop the existing process on port 8000 or use the dashboard it is already serving. |
| Dashboard cannot sign in | Check the URL and publishable key in `supabase/.env`, and the confirmed Auth account's email/password. |
| Signed in, but pages fail to load | Check Edge Function deployment, authentication errors, and database migrations. |
| Customer list is empty | Apply the fictional customer seed and deploy `test-cases`. |
| Call never connects | Check worker logs, microphone permission, matching LiveKit project credentials, and dispatch name `Voice-Agent-Case`. |
| Call works but details are missing | Check worker Supabase credentials and `session-observability` delivery. |
| Session does not finalize | Check the LiveKit webhook URL, signing credentials, and delivery logs. |

- [Complete setup and verification runbook](docs/SETUP.md)
- [Worker source map and deployment notes](Livekit-Agents/README.md)
- [Database schema and checks](supabase/README.md)
- [Collection tool behavior](Livekit-Agents/COLLECTION_TOOLS.md)
