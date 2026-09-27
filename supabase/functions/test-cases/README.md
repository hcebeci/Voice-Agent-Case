# Test customers

Authenticated `GET /functions/v1/test-cases` returns only fictional customer
fixtures (`is_test_record = true`) for the Tests page. The response includes
verification answers for the tester and current stages from the database view.
It does not expose arbitrary real customer accounts. Authentication is handled
by `withSupabase({ auth: "user" })`; the backend uses its admin client because
customer tables deliberately have no browser read grants.

Deploy with `npx supabase functions deploy test-cases` from the repository root.
The UI is served by `python3 start.py`; open `http://127.0.0.1:8000/#tests` and
sign in. Agent configuration and enabled tools come from the existing APIs.

The session endpoint derives tools from persisted assignments, validates supported
implementations and prerequisites, and snapshots the configuration for each call.
The test page never sends instructions, tool schemas, verification status, or
payment policy as trusted request arguments.

Validation:

```sh
node --test supabase/functions/livekit-session/configuration.test.mjs ui/tests/test-calls.test.cjs
```
