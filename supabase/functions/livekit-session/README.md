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

Configure these Supabase Edge Function secrets before using it:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Deploy from the repository root with:

```bash
npx supabase functions deploy livekit-session
```
