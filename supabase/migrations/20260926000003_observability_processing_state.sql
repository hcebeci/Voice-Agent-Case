-- Track processing so a failed observability write can be retried safely.

alter table public.session_events
  add column if not exists processed_at timestamptz,
  add column if not exists processing_error text;

comment on column public.session_events.processed_at is 'When the event was materialized into turn, trace, or tool records.';
comment on column public.session_events.processing_error is 'Last materialization error; a later retry may process the same source event again.';
