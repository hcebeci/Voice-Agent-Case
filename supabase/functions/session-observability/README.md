# Session observability ingestion

This authenticated internal function receives structured events from the
LiveKit worker. It stores the append-only event record, then materializes turn,
trace, and tool rows. The worker sends the Supabase secret key in the
`apikey` header, so this endpoint is not public even though platform JWT
verification is disabled.

Deploy from the repository root with:

```bash
npx supabase functions deploy session-observability
```

The local worker reads `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from
`supabase/.env`. Keep that file private and never expose the secret key to the
browser.
