# Test coverage review

Reviewed on 5 November 2026 by a three-reviewer engineering team covering Python
agent behavior, database/API reliability, and frontend/deployment verification.
The coordinator executed the maintained checks and independently reproduced the
database finding. Reviewers challenged overlapping findings before consolidation.

## Assessment

The suite has useful deterministic regression coverage, especially collection
guards, scripted SDK tool plumbing, transcript races, retry identity, and selected
database access/atomicity rules. Its strongest evidence is about application
logic. It provides much less assurance about real browser wiring, deployed
authentication, speech delivery, and ordinary-language decisions.

This review describes the **current local working tree**, including modified and
untracked tests and implementations. It does not imply that a fresh GitHub clone
or deployed version contains all of these checks. No numerical line or branch
coverage was measured. Test counts are execution results, not coverage percentages.

## Checks executed

| Check | Result | What this establishes |
| --- | --- | --- |
| `RUN_COLLECTION_MODEL_TEST=0 uv run --offline pytest -q`, from `Livekit-Agents/` | 60 passed, 1 skipped | Current worker tests pass; the opt-in real-model case did not run. |
| `node --test ui/tests/*.test.cjs supabase/functions/*/*.test.mjs`, from repository root | 55 passed | Browser-logic and backend-helper tests pass. |
| `python3 scripts/test-platform-database.py` | Passed: 15 migrations and `supabase/tests/platform.sql` | Fresh migrations apply to disposable PostgreSQL and the maintained SQL assertions pass. |
| `python3 scripts/sync-voice-catalog.py --check` | Passed | Generated voice catalog copies agree. |
| Additional missing-marker insert probe | Defect reproduced; insert rolled back | The retained-report database constraint accepts an empty customer snapshot. |

The worker command used a temporary uv cache directory. PostgreSQL execution
required permission outside the sandbox because shared-memory initialization was
blocked inside it. Both database runs used temporary clusters, cleared inherited
`PG*` settings, used private Unix sockets, and stopped their servers afterward.
No configured database, provider inference, live room, or hosted deployment was
used. Historical audit suites were inspected, not rerun or included in these counts.

## Coverage by area

| Area | Existing evidence | Important boundary |
| --- | --- | --- |
| Collection policy | Verification attempts, amount/date rejection, review/confirmation ordering, callback rules | Several invalidation and calendar/account edge cases remain untested. |
| Agent/SDK behavior | Real SDK sessions driven by predetermined model outputs | Proves event/tool mechanics, not language interpretation. |
| Worker configuration | Metadata parsing, voice resolution, dispatch-name check, startup retry helper | Does not execute the complete production worker entrypoint. |
| Observability | Turn/usage helpers, outbox delivery/restart/shutdown tests, one real SDK LLM-metrics test | Most transcript/tool events are manually constructed; full persistence/materialization is not covered by these tests. |
| Browser call logic | Transcript ordering, call retries/reload, escaping, auth-loss teardown, save/history races | Uses fabricated DOM, audio, room, and API objects. |
| Database | Fresh migration application, runtime write denial, atomic agent-save rollback, audit attribution, owner-scoped terminal close | Does not assert all new tables, grants, RPCs, or concurrency paths. |
| Edge Functions | Validation, pagination, lifecycle and usage helpers; separate extracted-handler audit harnesses | Most routes and actual authentication middleware are outside normal test execution. |
| Idempotency audits | Real SQL concurrency, response-loss recovery, transaction rollback and stale-state cases exist | Specialized fixtures are not integrated into the maintained runner; some historical helpers are stale. |
| Model/audio/deployment | One opt-in collection-model test and three default-assistant simulation scenarios | No live model or audio evidence was generated in this review; no discoverable root CI workflow. |

## Findings and recommended tests

### 1. P1 — Retained-report integrity has a demonstrated database gap

The constraint in [the validation-history migration](../supabase/migrations/20261105000020_validation_history.sql#L14)
checks `customer_snapshot->'is_test_record' = 'true'::jsonb`. An empty object
produces SQL NULL, which passes a CHECK constraint. This behavior is documented
in the [PostgreSQL constraint reference](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS).

The coordinator applied the current migration plan in a fresh disposable cluster
and inserted a report with `customer_snapshot = '{}'`. PostgreSQL returned `{}`
and `INSERT 0 1`; the transaction was then rolled back. Other required columns
contained synthetic placeholder values. This proves a database invariant gap,
not an unauthenticated HTTP exploit: the report validator may reject the same
input at the API boundary.

**Add:** SQL rejection cases for missing marker, JSON null, false, and scalar
snapshots; an acceptance case for explicit `is_test_record: true`; and actual
role-based insert/update/delete/select checks for `test_runs`. Then correct the
constraint so the marker must evaluate explicitly true. The existing
[SQL suite](../supabase/tests/platform.sql) does not test this table.

### 2. P1 — Normal-language safety is not proved by scripted tool calls

[ScriptedLLM](../Livekit-Agents/tests/test_collection_runtime.py#L16) selects its
tool calls from predetermined fixtures. This is useful SDK plumbing coverage.
The [real-model collection scenario](../Livekit-Agents/tests/test_collection_runtime.py#L256)
is opt-in and is only one conversation. Its initial identity-bypass probe checks
verification state and absence of effects, but does not assert that the spoken
reply avoids invented or premature account disclosure.

**Add:** ordinary-language cases for refusal, cancellation, conditional agreement,
questions after terms review, short “yes” replies in different contexts, and
backend failure. Assert tools and durable effects plus response meaning, including
absence of false success claims and unexpected additional events. Retain the
deterministic tests as the fast layer. The current
[simulation scenarios](../Livekit-Agents/scenarios.yaml) exercise the default
assistant, not the collection workflow.

### 3. P1 — Browser tests can pass with broken markup or button wiring

The [browser harness](../ui/tests/test-calls.test.cjs#L8) creates any queried
element, makes event registration a no-op, substitutes room/audio behavior, and
replaces API calls. Tests call application functions directly. A renamed HTML
element or disconnected button can therefore escape these checks.

**Add:** a real-browser smoke test that loads the actual HTML, signs in against
an isolated backend, saves an agent, selects a customer, starts/ends a call with
fake media, and opens the saved session. Keep a separately recorded live audio
check for actual microphone permissions, interruptions, and audible output.
Describe the existing suite as **browser call logic tests**.

### 4. P1 — There is no repository-level automated test gate

The workflow files live under `Livekit-Agents/.github/workflows/`; no root
`.github/workflows/` exists. GitHub requires workflows in the repository-root
directory described in its [workflow syntax reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
The nested [simulation workflow](../Livekit-Agents/.github/workflows/simulations.yml)
and scenario comments consequently overstate automatic merge execution.

**Add:** a root CI workflow for Python, Node, disposable SQL, and catalog
consistency. Set the worker working directory explicitly; simply moving the
existing workflow would leave its relative paths wrong. Keep paid simulations
separate with an explicit trigger and required credentials. Document one command
or maintained entrypoint that runs the intended deterministic release checks.

### 5. P1 — Valuable idempotency audits are not a repeatable standard suite

The [older database audit](../audits/idempotency/database/test_database_idempotency.py#L13)
imports the removed `Observation` symbol and reads a hardcoded temporary-cluster
configuration path. A security helper has the same obsolete import. Newer
[fix-validation tests](../audits/idempotency/fix_validation/test_database_fix_validation.py#L23)
use a different harness and need an explicitly prepared database. They should
not all be characterized as broken.

The [maintained database runner](../scripts/test-platform-database.py#L59) runs
only `supabase/tests/*.sql`. The ordinary README Python and Node commands do not
discover these audit suites. Historical passing audit counts therefore cannot
be presented as current repeatable release coverage.

**Add:** a maintained disposable fixture and command for the valuable current
concurrency, rollback, request-fingerprint, response-loss, and replay checks.
Repair stale imports and remove machine-specific fixture assumptions. Separate
exploratory defect reproductions from release tests that assert desired behavior.

### 6. P1/P2 — Endpoint and retained-evidence behavior needs execution tests

[Report tests](../supabase/functions/test-runs/validation.test.mjs) exercise a
validator, hash, and cursor. They do not call
[the handler](../supabase/functions/test-runs/handler.mjs#L45), which performs
user-versus-service authorization, manual evidence capture, persistence,
duplicate reconciliation, and history reads. Other Edge Function tests likewise
often stop at pure helpers. Extracted-handler audit harnesses bypass middleware
and replace signature/SDK boundaries.

**Add:** handler tests for user versus secret mode, unfinished and non-test
sessions, server-loaded evidence overriding client claims, evidence-query failure,
identical versus conflicting report retries, and unsupported update/delete
methods. Add actual HTTP integration checks for absent/expired JWTs, wrong
secrets, forged webhook signatures, valid signed events, ownership-sensitive
session closure, CORS, and method routing. Test event materialization failure
followed by an identical-event retry against real SQL.

These checks should respect the intended shared-organization access model;
cross-user read access is not automatically a defect.

### 7. P2 — The production worker entrypoint is outside the tested boundary

Tests construct the configured assistant directly, call startup helpers, or
manually attach listeners. They do not drive the complete
[worker entrypoint](../Livekit-Agents/src/agent.py#L251) through customer binding,
provider construction, room/session startup, and shutdown callbacks. The voice
test named [selected voice reaches TTS](../Livekit-Agents/tests/test_voice_configuration.py#L7)
only calls a resolution helper; it does not observe a TTS constructor.

**Add:** an offline entrypoint harness with a fake job context and captured
provider constructors. Assert instruction/tool/voice forwarding, both call
directions, bound startup failure, inactive snapshots, and cleanup. Add SDK-level
transcript and tool-lifecycle cases through the same production listeners.
Rename helper-only tests to match their evidence. Verify real synthesis separately.

### 8. P2 — Important collection invalidation branches need direct tests

The highest-value missing cases are changed **ineligible** terms invalidating
an old review ([collection.py](../Livekit-Agents/src/collection.py#L185)) and
policy/account/date changes requiring proposal revalidation before commitment
([collection.py](../Livekit-Agents/src/collection.py#L227)).

**Add:** create an eligible reviewed proposal, change its terms to an ineligible
offer, then try to commit the old proposal and assert no effect. Separately
change policy, account eligibility, and time between review and commit. Follow
with low-balance minimum adjustment, closed/zero-balance accounts, and local
midnight boundaries.

Historical SQL audits already cover stale customer snapshots, closed-session
effects, conflicts, concurrency, and unknown-outcome recovery. Those protections
should be preserved and made repeatable, not described as entirely absent.

## Recommended order

1. Add the missing-marker regression and fix the confirmed constraint gap.
2. Make current worker/Node/SQL/audit regressions repeatable from a fresh checkout,
   then run them through root CI.
3. Add retained-report handler and real authentication/signature integration checks.
4. Add production worker wiring and the two collection invalidation regressions.
5. Add a real-browser smoke path, then targeted ordinary-language and audio checks.

## Suggested README wording

> Automated tests cover collection rules, scripted SDK tool handling, browser-call
> logic, selected session-reporting helpers, and specific database access and
> atomicity contracts. Browser tests mock DOM, media, and network boundaries.
> Real-model tests and simulations are optional; deployed authentication, real
> audio, and complete browser-to-database behavior require separate verification.

Keep current-run results separate from historical audit evidence and local-only
work. Passing these checks is useful regression evidence, not a production
deployment certification.

This task added this review document only. It did not change application code,
test expectations, migrations, CI, or the README, and did not publish a commit.
