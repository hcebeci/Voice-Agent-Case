# Layered idempotency audit results

Date: 4 November 2026. Audit and tests only; no application fixes, real calls, production writes or deployment changes.

## Verdict

The system has effective database idempotency for collection operations that retain the same session/request key. It is not duplicate-proof across all entry points or regenerated operation identities.

| Path | Evidence | Verdict |
|---|---|---|
| Collection operation, same key | 12 simultaneous independent connections produce one callback and one receipt | Protected in tested database path |
| Lost response after commit | Runtime reconciles stored receipt; exactly one callback | Protected when original key survives and receipt becomes reachable |
| Receipt also unreachable | Runtime reports OUTCOME_UNKNOWN; later same-key retry recovers stored result | Correctly preserves uncertainty |
| Partial transaction failure | Injected failures at effect, state update, receipt and audit; also killed connection before COMMIT | All effects roll back; same-key retry succeeds once |
| Same payment proposal, new keys | Concurrent attempts plus refreshed retry | Proposal uniqueness prevents second commitment |
| Session creation, same header/key | Current handler invoked twice creates two sessions and two mocked dispatches | Confirmed duplicate-start gap |
| Callback retry under a new key | Identical callback arguments create two records | Retry identity gap if both requests represent one action; equal arguments alone cannot establish that |
| Same key, different tool/arguments | Old result returned silently, including under concurrent payload collision | Request integrity gap; no second effect demonstrated |
| Webhook event upsert | Fresh migrations reject ON CONFLICT target against partial unique index | Confirmed processing failure; not proof of duplicate business effects |
| Anonymous/authenticated access | Direct privilege catalogs plus actual denied operations | Protected by tested repository grants; deployed gateway not verified |

## Teams and completed feedback loops

Each team had a distinct lead and independent validator. Four-agent capacity required successive validator waves. The root coordinator challenged both teams and consolidated their evidence.

- Security: lead tested replay, isolation, privileges and closed sessions. Validator challenged generic permission errors, because schema denial could mask function privileges. Lead added explicit catalog tests, reran them, and validator independently reran the revised suite. Validator also narrowed request-ID trust: provider tool-call metadata is not a durable business-operation ID.
- Database: lead tested concurrency, atomicity and lost acknowledgments. Validator independently terminated a connection before COMMIT and checked stale customer snapshots. Validator requested a state-update failure test; lead added it and reran, followed by independent verification. They documented that local transaction tests use a superuser and the stub service_role lacks Supabase's BYPASSRLS behavior.
- Cross-team: independent concurrent mismatch probes corroborated the security team's semantic-collision finding. Both teams rejected the stronger claim that equal arguments necessarily mean duplicate intent. Security separately reviewed the root's current-handler session replay probe.

## Test interpretation and boundaries

Final root aggregate: **46 passed, 2 strict expected failures in 8.27 seconds**. Command: `IDEMPOTENCY_TEST_DB_CONFIG=/tmp/database-team-cluster.json Livekit-Agents/.venv/bin/python -m pytest audits/idempotency -q`. Unique passing cases: security lead 15, security validator 8, database lead 19, database validator 3, root handler probe 1. Repeated independent runs are excluded from this total.

Passing a reproduction test can confirm a defect. The two strict expected failures document desired guarantees that currently fail; they are not successful protection checks. Independent reruns strengthen evidence but are not counted as additional unique cases.

PostgreSQL tests use all eight repository migrations and disposable synthetic records, with separate connections for concurrent operations. HTTP boundaries are mocked to route runtime calls into actual SQL and inject response loss. The session-handler reproduction extracts the current handler body and mocks SDK/database boundaries: it proves handler behavior, not actual remote dispatch delivery.

This does not certify production indexes, PostgREST/JWT authorization, provider delivery, restart-generated operation IDs, or downstream callback execution. Payment commitments tested here are promises, not money transfers. Both SQL review teams share the database preparation helper, so provisioning is a shared dependency despite independent assertions.

## Evidence

- [Security lead review](security/SECURITY_REVIEW.md) and [independent verdict](security/validation/VERDICT.md).
- [Database lead review](database/FINDINGS.md) and independent tests in `database/validation/`.
- [Independent database verdict](database/validation/VERDICT.md).
- Current-handler replay reproduction: `test_session_handler_replay.py`.
- Team protocol and scope: `README.md`.

## Follow-up priorities

1. Define and persist session-creation identity so a replay can reuse its original session and reconcile dispatch outcome.
2. Preserve a durable callback-operation identity across retries and regenerated tool calls; explicitly distinguish a new customer intent.
3. Bind receipt keys to a defined tool/argument fingerprint and reject mismatched reuse.
4. Correct webhook conflict-target/index compatibility and test retry recovery end to end.

These are recommendations; no fixes were applied during this audit.

Scope check: all 701 tracked files matched the checksum baseline captured at the beginning of this team audit. Existing uncommitted product work was preserved; additions were limited to audit reports and tests.

Cleanup: disposable PostgreSQL cluster stopped successfully after final aggregate verification.
