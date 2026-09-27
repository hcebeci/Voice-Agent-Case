# Agent Metrics Edge Function

This authenticated endpoint returns aggregate usage and latency metrics for one
agent, together with its five most recent sessions.

`GET /functions/v1/agent-metrics?id=<agent-id>` returns session totals,
concurrent sessions, average token use per session, and average, p50, and p95
durations for recorded latency stages.
