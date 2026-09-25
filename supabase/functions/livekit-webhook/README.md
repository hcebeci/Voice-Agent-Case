# LiveKit lifecycle webhook

This function verifies LiveKit's signed webhook body, records every delivery by
its event id, and updates the matching application session. Duplicate deliveries
are acknowledged without applying the lifecycle transition twice.

Configure the webhook in LiveKit Cloud to point to:

```text
https://<project-ref>.supabase.co/functions/v1/livekit-webhook
```

Select the same LiveKit API key used by `LIVEKIT_API_KEY` for webhook signing.
The function uses the existing `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` Edge
Function secrets.
