# LiveKit browser session function

This authenticated function creates a `user_started` browser session, snapshots
the selected agent configuration, signs a short-lived LiveKit participant token,
and explicitly dispatches the shared `Voice-Agent-Case` worker with the snapshot
as job metadata. It also accepts lifecycle updates from the browser.

Configure these Supabase Edge Function secrets before using it:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Deploy from the repository root with:

```bash
npx supabase functions deploy livekit-session
```
