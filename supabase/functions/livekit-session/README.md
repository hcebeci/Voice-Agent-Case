# LiveKit browser session function

This authenticated function creates a browser session, snapshots
the selected agent configuration, signs a short-lived LiveKit participant token,
and explicitly dispatches the shared `Voice-Agent-Case` worker with the snapshot
as job metadata. Calls use `user_calls_agent` (user speaks first) or
`agent_calls_user` (agent speaks first); sources are recorded as `user_started`
and `platform_started`, respectively. Both directions use browser audio. The
function also accepts lifecycle updates from the browser. Rooms use
an explicit 20-second departure timeout so a closed browser is finalized by the
LiveKit webhook promptly.

Every POST must include an `Idempotency-Key` header (8–200 characters). The
browser creates a UUID once for a call attempt and retains it through uncertain
responses and reloads. Repeating the same normalized settings and key reuses
the saved session; reusing a key with changed settings returns 409. Keys are
scoped to the authenticated user and retained durably in `session_start_requests`.

Only one request can claim permission to dispatch. If the dispatch response is
lost, later requests inspect LiveKit's dispatch list for that room/session.
An unconfirmed outcome returns 202 `SESSION_START_PENDING` without a token;
retry using the same key. An empty dispatch list is not proof that an earlier
request failed, so the handler never automatically issues a second dispatch.
A crash after claiming ownership but before sending can therefore leave an
attempt pending; resolving that requires operator/provider reconciliation.
Replaying a closed session returns 409 `SESSION_CLOSED`; an intentional new call
uses a fresh key. Do not clear an uncertain key just to bypass pending status.

Apply the idempotency migrations before deploying this handler and the updated
browser client. Drain old worker sessions and coordinate the worker rollout:
collection RPC signatures now include argument binding and trusted user-message
evidence. The repository changes have been tested locally, not deployed.

Configure these Supabase Edge Function secrets before using it:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Deploy from the repository root with:

```bash
npx supabase functions deploy livekit-session
```


New session configuration is captured inside `session_start_reserve` under the
same agent row lock used by atomic editor saves. The database re-reads saved
fields and tool assignments, verifies implementation/prerequisite rules, and
ignores the compatibility `p_snapshot` parameter. Browser users cannot write
assignments outside the validated replacement RPC. Existing request receipts
retain their original snapshot even if the agent is later edited or archived;
archived agents still reject new request keys.
