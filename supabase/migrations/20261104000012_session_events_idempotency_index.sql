-- PostgREST's ON CONFLICT(source, source_event_id) needs a non-partial
-- unique index. PostgreSQL still permits multiple rows with NULL event IDs.
begin;
drop index if exists public.session_events_source_event_id_idx;
create unique index session_events_source_event_id_idx
  on public.session_events(source, source_event_id);
commit;
