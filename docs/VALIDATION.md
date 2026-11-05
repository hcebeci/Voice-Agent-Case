# Validation and retained test evidence

Telephony is deferred. The existing browser call directions and the user's manual
audio checks remain available. Manual audio checks, scripted SDK tests, real-model
text evaluations, cloud audio simulations and real database tests are distinct
types of evidence; one never substitutes for another.

## 1. Install without resetting the assessment database

Follow [SETUP.md](SETUP.md). `python3 scripts/migration-plan.py` prints the complete
ordered plan, including the historical manual audit migration. Existing projects
apply only migrations not already applied. The plan prints filenames only and
does not execute SQL. New schema and Edge Functions must be installed together.

New functions include `test-runs`. Its gateway JWT check is disabled because the
handler accepts either a verified user JWT or the server secret through
`@supabase/server`. Unauthenticated requests still fail. User-authenticated POSTs
can record only human audio reviews of saved fictional-customer calls; automated
imports require service authentication. GET requires authentication too.

## 2. Free offline regressions

From the repository root:

```sh
node --test ui/tests/*.test.cjs supabase/functions/*/*.test.mjs
cd Livekit-Agents
uv run pytest
uv run python src/evaluation.py --mode scripted
```

The scripted runner uses the real SDK, agent tools and `CollectionBackend`, with
predetermined model responses and an isolated in-memory RPC transport. It tests
tool mechanics and final effects. **It does not test language understanding or
audio.** Reports say so explicitly. These commands never publish reports or
contact the application database. The one existing real-model pytest is opt-in.

Scenario fixtures are in `Livekit-Agents/evaluation/scenarios.json`. They contain
full fictional customer information, including DOB `1988-04-12` and postal code
`34000`. This information is intentionally uncensored in scenarios, transcripts,
tool arguments and retained evaluation reports. Test artifacts are for synthetic
customers only; the history endpoint rejects real-customer captures.

Each run creates a new JSON file under `validation-results/`. Files are created
exclusively rather than overwritten. Failed and inconclusive runs stay alongside
passing runs. A new code revision gets a new run, not an edited historical verdict.

## 3. Real SQL and handler boundaries

Install PostgreSQL binaries and sync the worker environment, then run:

```sh
python3 scripts/test-platform-database.py
```

This creates a disposable local PostgreSQL cluster with a private socket and TCP
disabled, applies every migration, runs SQL assertions and stops/removes that
cluster. It ignores configured PostgreSQL credentials. It never resets or clears
the assessment database. `initdb`, `pg_ctl`, `psql`, Node 22.13+ and `uv` must be on
PATH. Some sandboxes require permission to create local shared memory.

Coverage includes:

- Authenticated users cannot insert, edit or delete runtime/audit history.
- Owners can close their sessions; another user cannot; terminal timestamps do
  not change on replay and terminal sessions cannot be reopened.
- Agent configuration/tool replacement rolls back fully when insertion fails.
- Provider edits produce configuration audit events with the authenticated actor.
- Actual observability Request/Response handler, SQL projections and session
  detail serializer agree after duplicate and reverse-order deliveries.
- A late older transcript cannot overwrite a newer transcript.
- Tool results arriving before starts, duplicate retries, and concurrent event
  transactions retain consistent terminal tool/trace status and record identity.
- First-audio latency is calculated after either timestamp arrives; a negative
  interval stays unknown rather than being displayed as an invented zero.
- Partial event processing recovers on retry without duplicating events/traces.
- Production collection backend executes actual SQL identity/minimum/review
  checks; lost commit acknowledgements recover exactly one saved commitment.

The SQL fixture models relevant Supabase roles and `auth.uid()`. The Node harness
injects the external SDK/auth adapter and replaces its PostgREST transport with
real SQL. **It does not verify deployed Supabase JWT verification, gateway/CORS,
or browser rendering.** Those remain deployment smoke checks.

## 4. Real-model and audio evaluations

The real-model runner is explicitly opt-in because it consumes inference credits:
It requires both exact final-state assertions and conversation judgments for the
scenario contract, accuracy and tool use. Missing/errored judgments produce an
inconclusive run; an uncertain judgment is retained with its reasons. Candidate
and judge calls both consume credits. `--judge-model` selects an independent
judge model if desired.

```sh
cd Livekit-Agents
uv run --env-file .env.local python src/evaluation.py --mode model --allow-inference
```

Use `--scenario changed-date` to select a case. Do not retry an unsuccessful
conversation until it passes; keep its failed evidence and investigate it.
Reports include source SHA-256 hashes at start/completion, configuration hashes,
model identifiers and dirty-checkout/commit provenance. A source change during
a run makes that run inconclusive. Text turn duration and measured audio response
latency are labeled separately, with p50/p95 and missing-sample counts.

For cloud simulations, the committed files use JSON syntax, which is valid YAML.
They were authored locally; no source was uploaded to a scenario generator.

```sh
uv run --env-file .env.local lk agent simulate text --scenarios scenarios.yaml
uv run --env-file .env.local lk agent simulate audio --scenarios scenarios.audio.yaml
```

These commands consume simulation and model allowances and may incur charges;
they are **not run automatically** by this change. Their entrypoint detects the
simulation context, seeds fictional state and a pinned clock, and never opens a
production collection/observability connection. The end callback checks exact
effects and can veto a conversational judge's passing verdict.

Cases cover eligible payment, manager override, wrong identity/lockout,
cancellation, agreement mixed with correction, unverified disclosure and an
interrupted readback. Positive cases prevent a system that refuses everything
from passing. Cancellation/correction cases must reach offer evaluation before
their no-effect/final-effect checks are meaningful. The cloud conversation judge
also checks disclosures and claims that cannot be inferred from database effects.

An audio simulation checks speech behavior but does not establish a carrier or
SIP trunk works. For manual inbound/outbound browser audio, retain separate runs
for each direction, noting answer/reject/hangup, interruptions, understood terms
and the final saved outcome.

## 5. Reviewer-facing history

After a synthetic browser call ends, use **Record audio validation** in Tests.
Choose a scenario name, state the expected result, record passed/failed/
inconclusive and add notes. The server captures saved effects, configuration,
transcript and measured latency. The verdict is explicitly attributed to a human;
the system does not automatically mark a call passed because it connected.

Validation history in Tests shows execution type, scenario, configuration/policy
versions, expected and actual results, assertions, uncensored fictional customer
facts, transcript, available latency and provenance. Older pages remain accessible.
Manual capture is a snapshot: subsequent late telemetry does not rewrite it.

Local automated JSON reports can be appended to hosted history by adding
`--publish` to the evaluation runner with `SUPABASE_URL` and
`SUPABASE_SECRET_KEY` provided privately to the process. This is never automatic.
Uploading an identical report ID is idempotent; reusing it for different evidence
returns a conflict. There are no edit/delete endpoints for retained reports.

## 6. Logging durability and limits

The worker attaches provider metrics to its actual LLM instance. An integration
regression checks event emission, rather than manually invoking only a handler.
Worker telemetry is first committed to a bounded SQLite outbox with stable event
IDs and per-session sequences. Failed delivery stays pending and replays after
restart; shutdown has a deadline rather than waiting indefinitely for an outage.

Set `VOICE_AGENT_OBSERVABILITY_SPOOL_DIR` to writable persistent storage for
deployed workers. The default is under the user's state directory, outside the
source tree. Container-local storage does not survive container replacement.
Outbox exhaustion rejects new captures with explicit errors; it does not silently
evict older events. Permanent errors can block delivery behind the oldest event.
Monitor pending counts and capture errors; this is not a guarantee of unlimited
or lossless logging under disk failure/capacity exhaustion.

The previous documented blanket identity-redaction promise has been corrected.
The separate SQL collection audit still sanitizes verification arguments; full
fictional evidence remains in test transcripts/tool telemetry as requested.

## 7. CI and remaining deployment checks

`.github/workflows/validation.yml` runs Node/Python regressions, scripted
conversations, all migrations and isolated SQL/handler tests. It uploads evidence
even when a job fails. CI artifacts expire after 30 days; local files and hosted
validation rows have no automatic deletion introduced by this implementation.
No paid real-model/audio runs or production report publishing occur in CI.

Before claiming hosted validation: deploy the matching migrations/functions and
worker, test ordinary-user access through actual Supabase Auth, verify both
manual audio directions and retained evidence, and inspect the real dashboard.
No authoritative scheduled provider-backed stuck-call reconciler is added;
dashboard reads no longer guess that a healthy long call failed.
