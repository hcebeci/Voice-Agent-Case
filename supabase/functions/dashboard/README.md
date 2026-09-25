# Dashboard Edge Function

This authenticated endpoint returns the first dashboard summary for the single
organization workspace.

`GET /functions/v1/dashboard` returns daily session totals, derived runtime
status for every agent, today's session timeline, and the latest five sessions.

Pass `?date=YYYY-MM-DD` to inspect a specific UTC calendar day.
