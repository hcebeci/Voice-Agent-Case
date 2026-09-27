-- PostgREST ON CONFLICT(source, source_event_id) cannot infer partial indexes.
-- Ordinary unique indexes still allow multiple NULL source_event_id values.
begin;
drop index if exists public.session_traces_source_event_id_idx;
create unique index session_traces_source_event_id_idx
  on public.session_traces(source, source_event_id);
drop index if exists public.tool_calls_source_event_id_idx;
create unique index tool_calls_source_event_id_idx
  on public.tool_calls(source, source_event_id);
commit;
