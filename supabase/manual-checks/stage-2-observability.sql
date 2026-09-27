-- Stage 2 read-only checks for the Supabase SQL editor.
-- These queries do not change data and can be run independently.

-- 1) No source event should have more than one receipt row.
select source, source_event_id, count(*) as receipt_count
from public.session_events
where source_event_id is not null
group by source, source_event_id
having count(*) > 1
order by receipt_count desc;

-- 2) Find events that failed materialization or are still waiting for a retry.
select id, session_id, source, event_type, source_event_id, received_at, processing_error
from public.session_events
where processed_at is null or processing_error is not null
order by received_at desc;

-- 3) Find repeated cumulative usage snapshots within one session.
select session_id, payload, count(*) as duplicate_count
from public.session_events
where event_type = 'session.usage'
group by session_id, payload
having count(*) > 1
order by duplicate_count desc;

-- 4) Reconcile stored session totals against the latest materialized usage row.
select s.id as session_id,
       s.status,
       coalesce(m.total_input_tokens, 0) as input_tokens,
       coalesce(m.total_output_tokens, 0) as output_tokens,
       m.captured_at
from public.sessions s
left join public.session_metrics m on m.session_id = s.id
order by s.created_at desc
limit 100;

-- 5) Detect missing or duplicate turn numbers per session.
select session_id,
       count(*) as stored_turns,
       min(turn_number) as first_turn,
       max(turn_number) as last_turn,
       count(distinct turn_number) as distinct_turns
from public.session_turns
group by session_id
order by session_id;

-- 6) Review latency values used by the session and agent metrics.
select session_id,
       count(*) filter (where total_latency_ms is not null) as completed_latency_turns,
       avg(total_latency_ms) as average_latency_ms,
       percentile_cont(0.50) within group (order by total_latency_ms) as p50_latency_ms,
       percentile_cont(0.95) within group (order by total_latency_ms) as p95_latency_ms
from public.session_turns
where total_latency_ms is not null
group by session_id
order by session_id;

-- 7) Find sessions that may have stale runtime badges.
select id, room_name, status, created_at, started_at, last_livekit_event_at, ended_at
from public.sessions
where status in ('connecting', 'active')
order by coalesce(last_livekit_event_at, started_at, created_at);

-- 8) Confirm traces and tool records point to existing sessions.
select 'trace_without_session' as check_name, count(*) as count
from public.session_traces t
left join public.sessions s on s.id = t.session_id
where s.id is null
union all
select 'tool_without_session', count(*)
from public.tool_calls t
left join public.sessions s on s.id = t.session_id
where s.id is null;
