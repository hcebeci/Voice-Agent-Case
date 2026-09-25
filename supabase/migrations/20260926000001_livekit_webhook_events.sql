-- Durable receipt log for LiveKit webhook delivery and retry handling.
create table if not exists public.livekit_webhook_events (
  event_id text primary key,
  event_type text not null,
  room_name text,
  occurred_at timestamptz,
  received_at timestamptz not null default timezone('utc', now()),
  processed_at timestamptz,
  processing_error text,
  payload jsonb not null default '{}'::jsonb
);

comment on table public.livekit_webhook_events is 'Idempotent receipt log for signed LiveKit webhook events.';
comment on column public.livekit_webhook_events.event_id is 'LiveKit event id; duplicate deliveries are ignored by this primary key.';

create index if not exists livekit_webhook_events_room_time_idx
  on public.livekit_webhook_events(room_name, occurred_at);

alter table public.sessions
  add column if not exists last_livekit_event_at timestamptz;

comment on column public.sessions.last_livekit_event_at is 'Most recent verified LiveKit webhook timestamp for lifecycle reconciliation.';

alter table public.livekit_webhook_events enable row level security;

drop policy if exists authenticated_livekit_webhook_events on public.livekit_webhook_events;
create policy authenticated_livekit_webhook_events on public.livekit_webhook_events
for select to authenticated using (true);
