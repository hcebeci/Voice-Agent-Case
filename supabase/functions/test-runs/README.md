# Retained validation history

Authenticated GET lists immutable synthetic validation reports (`?limit=20` and
`?cursor=...`) or returns a report with `?id=<uuid>`. Responses are `{runs,
next_cursor}` and `{run}` respectively. Stable ordering is `created_at,id` descending.

User-authenticated POST accepts only `execution_type: manual_audio`, a saved
synthetic collection `session_id`, scenario ID/name, an object `expected_outcome`,
verdict (`passed`, `failed`, `inconclusive`), optional notes and a stable UUID `id`.
The handler captures actual effects/configuration/transcript from saved records.
It does not trust client-provided actual effects or fictional-customer markers.
The verdict is labeled human. Repeat the same ID/input after an uncertain response
to return the original capture even if later telemetry arrived. Changed input or
owner gets 409. Start a new review with a new ID.

Server-secret POST imports automated reports matching validation.mjs. All reports
must explicitly identify synthetic customers. Their full DOB/postal and transcript
values are intentionally preserved. An identical imported ID is idempotent;
different evidence under an existing ID returns 409. No edit/delete API exists.

Apply migrations and deploy this function before using the new Tests history.
`verify_jwt=false` allows the server-secret mode through the gateway, while
`withSupabase({auth:['user','secret']})` authenticates every request internally.
Never send the server secret to the browser. Existing single-workspace visibility
applies to all reports. See [validation guide](../../../docs/VALIDATION.md).
