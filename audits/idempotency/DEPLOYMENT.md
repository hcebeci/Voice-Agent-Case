# Live idempotency release

Released 4 November 2026. LiveKit deployment time: 15:53:57 UTC. This supersedes the “not deployed” status in FIX_REPORT.md.

## Targets and deployed versions

| Component | Target / version | Verification |
|---|---|---|
| Supabase | voice-agent-case / kbmroangudidkywlotbw | Existing configured URL and linked project matched |
| Database | Migrations 20261104000010, 20261104000011, 20261104000012 | All succeeded; PostgREST schema cache reloaded |
| livekit-session | 8 → 10 | ACTIVE; gateway JWT verification retained; temporary maintenance version 9 replaced |
| livekit-webhook | 4 → 5 | ACTIVE; gateway JWT disabled as before, handler signature verification retained |
| session-observability | 9 → 10 | ACTIVE; internal handler authentication retained |
| LiveKit agent | CA_gt5YfAPeqxha / C2JBooEMZSed | Production version Available; deployment Running; startup logs confirm worker registration |
| Previous worker | DkGuZxXXQeVJ | Retained as rollback version |
| Dashboard | http://127.0.0.1:8000 | Served app.js exactly matches updated local file; no frontend build needed |

The unrelated multilingual voice migration and agents API changes were not deployed as part of this release. The worker build contains the current tested worker source and its required resources.

## Rollout

1. Confirmed zero LiveKit rooms and zero connecting/active database sessions.
2. Downloaded deployed function source and saved old collection RPC definitions outside the workspace.
3. Deployed a short-lived call-start maintenance response to prevent calls across incompatible RPC versions.
4. Stopped the stale local development worker so it cannot compete for production dispatches.
5. Applied the three tested idempotency migrations individually through the linked project's SQL command. Historical baseline migrations and customer seeds were not replayed. This follows the repository's manual SQL deployment convention, not a wholesale db push or migration-ledger rewrite.
6. Deployed the cloud worker and the webhook/observability functions, then replaced maintenance with the final session handler.
7. Verified the final worker is running and registered, function versions are active, and browser/API checks pass.

The LiveKit release attribute is release=idempotency-20261104. Local source hashes and rollback copies are in /tmp/idempotency-live-release/. Temporary files are recovery aids, not a durable backup service. Keep this release record with the repository.

## Live verification

The following database checks ran in a transaction and were rolled back entirely: same-key session reservation, payload mismatch rejection, one dispatch owner, collection receipt replay, callback effect count, tool mismatch rejection, and retry-safe webhook event upsert. Temporary synthetic customer/session/callback/event rows did not persist; existing user/customer records were not altered.

Read-only HTTP checks passed:

- Browser OPTIONS preflight returned 204 and allowed Idempotency-Key.
- Unauthenticated call creation returned 401.
- Unsigned webhook returned 401.
- Unauthenticated worker event returned 401.
- The new collection_snapshot signature returned HTTP 200/null through live REST for a nonexistent session, using the existing worker credential.
- The local server returned the updated app.js byte for byte.

Deployment logs showed successful process initialization and registered worker on LiveKit Agents 1.8.3, with no startup failure in the inspected sample. A nonblocking agent_name deprecation warning remains; it was not changed during this release.

## Verification boundary

A proposed authenticated HTTP smoke test would have created a temporary Auth user, agent, session and dispatch. Automatic approval review rejected that action because the script lacked cleanup and explicit authorization for persistent production test fixtures. The command did not run; no such fixtures or calls were created. The deployment was instead verified through rolled-back SQL checks, read-only HTTP requests, deployment status and startup logs. A real end-to-end audio conversation remains untested after this release.

## Recovery

If recovery is necessary, pause new calls first. Previous Edge Function sources are under /tmp/idempotency-live-release/supabase/functions/. The saved rollback-collection-rpcs.sql restores the previous RPC signatures and grants while retaining additive tables/columns. The previous LiveKit version is DkGuZxXXQeVJ. Restore matching worker/API/RPC contracts together; do not roll back only the worker against incompatible RPC signatures. No rollback was needed for this release.

The dashboard reads source files on each request; refresh an already open browser tab to load the new client code. The local development worker was intentionally stopped; cloud production now handles dispatches.

Workflow: [operating-livekit-agents](../../.agents/skills/operating-livekit-agents/SKILL.md) and [reading-livekit-docs](../../.agents/skills/reading-livekit-docs/SKILL.md). Generic deployment-documentation feedback was attempted; automatic approval review timed out before that optional action executed.
