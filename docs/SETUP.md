# Complete setup runbook

Use this guide to bring a fresh checkout and fresh hosted projects to a working
browser call. The [README](../README.md#run-the-full-application) explains the
application and everyday startup. All paths and commands below start at the
repository root unless a command changes directory.

## 1. Gather access and tools

An engineer or coding agent can perform the database, function deployment, and
initial application configuration below when it has authorized access to the
target projects. Account creation, billing, credentials, and a browser's
microphone permission still require the account owner's access. Never invent
credentials or report a deployment as verified before checking the actual project.

Install Python 3.10–3.14, uv, Node.js/npm, the Supabase CLI (the commands use
`npx supabase`), and the LiveKit CLI (`lk`). The command-line SQL route also
requires PostgreSQL's `psql` client. Use a LiveKit Cloud project with Inference
access and a hosted Supabase project.

| Input | Where it comes from | Where it is used |
| --- | --- | --- |
| Supabase project reference | Supabase project dashboard | CLI link/deployment target |
| Supabase URL, publishable key, secret key | Supabase project API settings | `supabase/.env` |
| Database connection details and password | Supabase **Connect** dialog | Initial SQL application with `psql` |
| Supabase account/CLI access | `npx supabase login`, or an authorized `SUPABASE_ACCESS_TOKEN` | Function deployment |
| LiveKit URL, API key, API secret | LiveKit Cloud project settings | Worker environment and Edge Function secrets |
| Application email and password | Choose a dedicated sign-in identity | Supabase Auth and dashboard login |

The database password, Supabase account token, Supabase secret key, and application
password are different credentials. Project API keys do not grant CLI account
access or replace a PostgreSQL password.

### Create or select your hosted projects

With authorized dashboard access, an engineer or agent can provision both
projects before filling in the files below:

1. In the [Supabase dashboard](https://supabase.com/dashboard), select the
   intended organization. Reuse a designated empty project, or choose **New
   project**, enter a name, choose a region, and generate and privately save its
   database password. Wait until the project is ready. Record its project
   reference, URL, and the `default` publishable and secret keys from API
   settings. Open **Connect** for the database connection parameters.
2. In [LiveKit Cloud](https://cloud.livekit.io/), select the intended account
   and create or select a project. Record its project URL, then create or select
   an API key in project settings and privately save its secret. Confirm the
   project can use LiveKit Inference; resolve any account or billing requirement
   shown by the service before attempting a call.
3. Keep these project identities in the deployment notes. Use their credentials
   consistently for the worker, deployed functions, and webhook. Reusing the
   original author's project configuration is not part of setup.

For a CLI-driven Supabase provisioning flow, the supported commands are
`npx supabase orgs list`, `npx supabase projects list`, and
`npx supabase projects create <project-name>`. Inspect
`npx supabase projects create --help` for the installed version's organization,
region, and password options, and keep the password out of logged command text.
See the [Supabase CLI reference](https://supabase.com/docs/reference/cli/introduction#supabase-projects-create)
and [database connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).
The dashboard route above also supports agents with browser access. Account
sign-in, organization permissions, and any required billing must already be
authorized; repository contents cannot supply them.

## 2. Create private environment files

Create missing files only; preserve populated files on an existing checkout:

```bash
test -f supabase/.env || cp supabase/.env.example supabase/.env
test -f Livekit-Agents/.env.local || cp Livekit-Agents/.env.example Livekit-Agents/.env.local
```

Fill `supabase/.env` with `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and
`SUPABASE_SECRET_KEY`. Fill `Livekit-Agents/.env.local` with `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. Use the same LiveKit project in every
step. `SUPABASE_JWKS_URL` is optional.

These files use plain `NAME=value` lines. Keep them private. The local worker
also reads `supabase/.env`; the web server sends only the URL and publishable key
to the browser. Do not put backend secrets in `ui/` or commit populated files.

## 3. Apply the database in this exact order

Use a fresh Supabase database. Run these files in the Supabase SQL Editor, one
file at a time, stopping on the first error:

1. `supabase/migrations/20260925_000001_initial_schema.sql`
2. `supabase/manual-migrations/20260925_000002_agent_change_history.sql`
3. `supabase/migrations/20260926000001_livekit_webhook_events.sql`
4. `supabase/migrations/20260926000002_observability_event_contract.sql`
5. `supabase/migrations/20260926000003_observability_processing_state.sql`
6. `supabase/migrations/20260927000001_collection_customers.sql`
7. `supabase/migrations/20260927000002_agent_tts_settings.sql`
8. `supabase/migrations/20260927000003_collection_tools.sql`
9. `supabase/migrations/20260928000001_observability_upsert_indexes.sql`
10. `supabase/seeds/collection_customers.sql`

The seed creates six fictional customers. The tool migration registers four
implemented tools. Neither creates an agent or a sign-in user.

The initial migration has a historical filename and agent history is outside
the CLI migration directory. This ordered list is the bootstrap contract;
`supabase db push` alone does not reproduce it. SQL Editor and direct `psql`
application also do not populate the Supabase CLI migration ledger. Record the
files applied and their commit before later adopting CLI migration management.

### Command-line alternative for an agent

Obtain connection parameters from the project's **Connect** dialog. Prefer a
direct or session-pooler connection that your machine can reach. Set `PGHOST`,
`PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` privately in the process
environment; use the values from that dialog, including its full pooler username
when applicable. Set `PGSSLMODE=require`. Do not print credentials or include
them in a committed script. PostgreSQL also supports a private password file.

Check the target before making changes:

```bash
psql -X --no-password -v ON_ERROR_STOP=1 -c \
  "select current_database(), current_user, to_regclass('public.agents') as existing_agents;"
```

If `existing_agents` is non-null, follow **Existing projects and reruns** below.
For a confirmed fresh target, run this block in Bash. It checks each result and
records only successfully applied filenames in a local temporary ledger:

```bash
bash <<'BASH'
set -euo pipefail
ledger=$(mktemp "${TMPDIR:-/tmp}/voice-agent-sql.XXXXXX")
printf 'Applied-file ledger: %s\n' "$ledger"
for sql in \
  supabase/migrations/20260925_000001_initial_schema.sql \
  supabase/manual-migrations/20260925_000002_agent_change_history.sql \
  supabase/migrations/20260926000001_livekit_webhook_events.sql \
  supabase/migrations/20260926000002_observability_event_contract.sql \
  supabase/migrations/20260926000003_observability_processing_state.sql \
  supabase/migrations/20260927000001_collection_customers.sql \
  supabase/migrations/20260927000002_agent_tts_settings.sql \
  supabase/migrations/20260927000003_collection_tools.sql \
  supabase/migrations/20260928000001_observability_upsert_indexes.sql \
  supabase/seeds/collection_customers.sql
do
  psql -X --no-password -v ON_ERROR_STOP=1 -f "$sql"
  printf '%s\n' "$sql" >> "$ledger"
done
psql -X --no-password -v ON_ERROR_STOP=1 \
  -f supabase/manual-checks/collection-customers.sql
BASH
```

Keep the ledger and checkout commit in your deployment notes. An individual
file can contain multiple statements or its own transaction: stopping on an
error does not guarantee that the failed file made no changes.

## 4. Deploy the backend functions and secrets

From the repository root, link the intended project:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
```

For noninteractive setup, supply an authorized `SUPABASE_ACCESS_TOKEN` in the
process environment and skip `npx supabase login`. Supply the database password
privately as `SUPABASE_DB_PASSWORD` if the link operation requires it. Neither
value belongs in browser configuration or a committed file.

Upload the LiveKit values without copying secrets into command arguments. This
block reads the worker file and creates a private temporary secrets file:

```bash
python3 - <<'PY'
from pathlib import Path
import os
import subprocess
import tempfile

values = {}
for line in Path("Livekit-Agents/.env.local").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
keys = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
if any(not values.get(key) for key in keys):
    raise SystemExit("Fill all three LiveKit values before deploying.")
fd, filename = tempfile.mkstemp(prefix="voice-agent-secrets-")
try:
    with os.fdopen(fd, "w") as handle:
        handle.write("\n".join(f"{key}={values[key]}" for key in keys) + "\n")
    subprocess.run(["npx", "supabase", "secrets", "set", "--env-file", filename], check=True)
finally:
    Path(filename).unlink(missing_ok=True)
PY
npx supabase functions deploy --use-api
npx supabase functions list
```

Expect nine functions: `agents`, `tools`, `dashboard`, `sessions`,
`agent-metrics`, `test-cases`, `livekit-session`, `livekit-webhook`, and
`session-observability`. Local `.env` files are not uploaded automatically.
Supabase supplies its platform environment to deployed functions; only the
three custom LiveKit secrets above need this upload step.

Preserve `supabase/config.toml`: `livekit-webhook` verifies LiveKit's signature,
and `session-observability` authenticates a backend secret. Their gateway JWT
check is disabled intentionally. User-facing functions require an actual
signed-in user's access token. A publishable key alone does not sign a user in.
See [Supabase function authentication](https://supabase.com/docs/guides/functions/auth)
and the [CLI reference](https://supabase.com/docs/reference/cli/introduction).

## 5. Configure LiveKit lifecycle delivery

In the same LiveKit Cloud project, create a webhook under **Settings → Webhooks**:

```text
https://<project-ref>.supabase.co/functions/v1/livekit-webhook
```

Select the same LiveKit API key uploaded to the function secrets. Enable room
and participant lifecycle events, including `room_started`,
`participant_joined`, `participant_connection_aborted`, `participant_left`, and
`room_finished`. Inspect delivery status after the first browser call.

This step needs LiveKit project administration access. An agent with authorized
dashboard access can configure it; otherwise the account owner must complete
it. Creating a room or deploying a function does not register the webhook.

## 6. Create a sign-in user and configured agent

The dashboard supports sign-in only. The manual route is to create a confirmed
email/password user in Supabase **Authentication → Users**, sign in to the
dashboard, and create an agent with the four collection tools assigned.

For an agent-driven route, use the following bootstrap after function deployment.
It uses the supported [Supabase Auth admin API](https://supabase.com/docs/reference/javascript/auth-admin-createuser),
then calls this repository's authenticated `agents` and `tools` endpoints. It
does not insert Auth rows directly or bypass the application API to create an
agent. The sample instructions below establish a usable collection assistant;
review them before changing its behavior.

Set `APP_EMAIL` and `APP_PASSWORD` privately in the environment. For a new user,
also set `CREATE_APP_USER=1`. Leave that flag unset when the user already exists;
the script does not reset passwords or change existing users. This step needs
Node.js 22 or newer for the bootstrap example and network access to npm.

Run the block from the repository root. Its temporary npm installation is outside
the checkout. It prints the configured agent ID, never a token or password:

```bash
bash <<'BASH'
set -euo pipefail
export SETUP_REPOSITORY_ROOT="$PWD"
workspace=$(mktemp -d "${TMPDIR:-/tmp}/voice-agent-bootstrap.XXXXXX")
trap 'rm -rf "$workspace"' EXIT
cd "$workspace"
npm install --no-save --package-lock=false @supabase/supabase-js
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const values = Object.fromEntries(readFileSync(
  `${process.env.SETUP_REPOSITORY_ROOT}/supabase/.env`, 'utf8'
).split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
 .map(line => {
   const i = line.indexOf('=');
   if (i < 1) throw new Error('Expected NAME=value in supabase/.env');
   return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
 }));
const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: publicKey,
  SUPABASE_SECRET_KEY: secretKey } = values;
const { APP_EMAIL: email, APP_PASSWORD: password } = process.env;
if (![url, publicKey, secretKey, email, password].every(Boolean)) {
  throw new Error('Missing Supabase values or APP_EMAIL/APP_PASSWORD');
}
const options = { auth: { persistSession: false, autoRefreshToken: false } };
if (process.env.CREATE_APP_USER === '1') {
  const admin = createClient(url, secretKey, options);
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
}
const client = createClient(url, publicKey, options);
const { data, error } = await client.auth.signInWithPassword({ email, password });
if (error) throw error;
async function api(path, method = 'GET', body) {
  const response = await fetch(`${url}/functions/v1/${path}`, {
    method,
    headers: { apikey: publicKey, Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
const name = 'Collection Assistant';
const matches = (await api('agents')).agents.filter(a => a.name === name);
if (matches.length > 1) throw new Error('Multiple agents have the bootstrap name; select one manually.');
let agent = matches[0];
if (agent?.archived_at) throw new Error('Bootstrap agent is archived; restore or select another explicitly.');
if (!agent) {
  ({ agent } = await api('agents', 'POST', {
    name, description: 'Customer-bound collection conversations',
    model: 'openai/gpt-4.1-mini', language: 'en', tts_model: 'cartesia/sonic-3',
    instructions: 'You are a respectful collection assistant. Before discussing account details, ask for date of birth and postal code and use verify_identity. Never guess verification success. After verification, explain the account facts supplied by the tools. Use evaluate_offer for any proposed amount and date. Let evaluate_offer present the exact eligible terms and confirmation question; wait for the customer\'s later explicit agreement before create_payment_commitment. Re-evaluate changes. Use request_callback only when the customer requests it and a registered phone is available. Never claim a payment was taken, a call scheduled, or a transfer made. Explain rejected or uncertain tool outcomes accurately. Keep spoken replies brief and clear.',
  }));
}
const expected = ['verify_identity', 'evaluate_offer', 'create_payment_commitment', 'request_callback'];
const { tools } = await api(`tools?agent_id=${agent.id}`);
const selected = expected.map(key => {
  const matches = tools.filter(tool => tool.execution_key === key && tool.is_enabled);
  if (matches.length !== 1) throw new Error(`Expected one enabled tool for ${key}`);
  return matches[0];
});
const assigned = tools.filter(tool => tool.assigned);
if (!assigned.length) {
  await api(`tools?agent_id=${agent.id}`, 'PUT', {
    assignments: selected.map(tool => ({ tool_id: tool.id, configuration: {} })),
  });
} else if (assigned.length !== selected.length || selected.some(t => !t.assigned)) {
  throw new Error('Existing assignments differ; inspect before replacing them.');
}
const testCases = await api('test-cases');
if (!Array.isArray(testCases.customers) || testCases.customers.length !== 6) {
  throw new Error('Fresh setup should expose six fictional customers; inspect the seed and test-cases endpoint.');
}
console.log(`Configured agent: ${agent.id}. Verified six test customers.`);
await client.auth.signOut({ scope: 'local' });
JS
BASH
```

On a rerun, unset `CREATE_APP_USER`, retain the same credentials, and inspect the
existing agent's saved instructions. Matching agents are reused without rewriting
their configuration. Tool assignment uses `PUT`, which replaces the complete
assignment set; the example refuses to replace a different existing set.

Adding a tool definition in the UI does not implement new backend behavior.
The worker currently supports only the four execution keys above. Payment tools
require `verify_identity`; `create_payment_commitment` also requires `evaluate_offer`.

## 7. Run both local processes

Terminal 1, repository root:

```bash
python3 start.py
```

Terminal 2, repository root:

```bash
cd Livekit-Agents
uv sync
uv run --env-file .env.local lk agent dev
```

Open `http://127.0.0.1:8000` and sign in with the Auth user's credentials. Keep
both terminals running. Stop each with **Ctrl+C**. The dashboard server needs no
frontend build or separate package installation; the Python worker dependencies
are installed by `uv sync`. No additional local API or LiveKit server is needed.

The `--env-file` option loads the worker's LiveKit values before the CLI selects
a project. This avoids relying on the original author's tracked `livekit.toml`.
Remove stale exported `LIVEKIT_*` values first: existing process variables take
precedence over values from an environment file.

## 8. Verify an actual call

1. Open **Tests**, select the configured agent and a customer.
2. Select a direction and click **Start test call**. Allow microphone access.
3. Speak as that fictional customer, using the displayed identity answers.
4. Verify that account information is withheld until identity verification.
5. Try a payment proposal, explicitly confirm an eligible offer, then end the call.
6. Open **View last test call**. Check the transcript, tool results, session status,
   and available metrics. Inspect worker logs and webhook deliveries if data is missing.

The customer records do not speak automatically. Both directions use the browser
microphone. Commitments are database records; no money moves. Callback requests
do not schedule a call, and the supplied customers have no registered phone
number, so callback creation is expected to fail for those unchanged fixtures.

Sessions normally finish about 20–35 seconds after the last participant leaves,
including the dashboard polling interval. If they stay active, check the webhook
URL, selected signing API key, event delivery, and function logs. If the worker
does not join, check its registration name (`Voice-Agent-Case`), LiveKit project
credentials, and worker logs. If customer tools or metrics are absent, check
the worker's private Supabase URL/secret and the relevant deployed functions.

The seed dates are fixed; displayed collection stages age with the current
Istanbul date. Use the fixed reference date in
`supabase/manual-checks/collection-customers.sql` for repeatable assertions.

## Existing projects and reruns

- Inspect migration/deployment records and the actual schema before applying
  changes. Apply only outstanding files in dependency order. Do not replay the
  full bootstrap: policies, triggers, and other statements are not all idempotent.
- If SQL application fails, preserve the error and successful-file ledger.
  Inspect the failed file's existing objects before resuming; some statements
  may already have committed. Do not reset or delete an existing database to
  make the setup pass.
- The customer seed inserts missing account references. Rerunning it does not
  reset balances, phone numbers, account dates, commitments, or session history.
  Its strict customer check expects the original fixtures, including null phones.
- Updating function secrets and redeploying functions is repeatable. Confirm
  the linked project first. Keep the deployed LiveKit credentials aligned with
  the worker and webhook signing key.
- Do not reset existing Auth users or overwrite existing agent configurations
  during bootstrap. Use the existing credentials and inspect mismatches.

For deeper backend checks, see [the Supabase guide](../supabase/README.md) and
[collection tool validation](../Livekit-Agents/COLLECTION_TOOLS.md#validation).
The collection SQL validation writes temporary fixtures and rolls them back;
run it against an isolated database as documented. Automated tests and live
call verification cover different parts of the system.
