# Sessions Edge Function

`GET /functions/v1/sessions` returns `{ sessions, next_cursor }`, with fifty
sessions per page by default. Use `?agent_id=<agent-id>` to filter for one agent
and `?limit=100` to request the largest supported page.

Pass the returned opaque `next_cursor` as `?cursor=<next_cursor>` with the same
agent filter and page size to retrieve older calls. A null cursor marks the last
page. Results use descending creation time and ID, so calls with equal timestamps
are paged consistently. Invalid cursors return HTTP 400.

`GET /functions/v1/sessions?id=<session-id>` returns the saved session, turns,
traces, tool calls, events, and calculated metrics. Every route requires a signed
in workspace user and uses their database access policies.
