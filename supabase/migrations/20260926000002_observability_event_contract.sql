-- Add the fields needed to collect and retry worker observability events.
-- Existing session, turn, trace, and tool tables remain the source of truth.

alter table public.session_events
  add column if not exists source text not null default 'platform',
  add column if not exists source_event_id text,
  add column if not exists received_at timestamptz not null default timezone('utc', now()),
  add column if not exists sequence_number bigint;

alter table public.session_events
  drop constraint if exists session_events_source_check;

alter table public.session_events
  add constraint session_events_source_check
  check (source in ('livekit_webhook', 'agent_worker', 'platform'));

alter table public.session_events
  drop constraint if exists session_events_sequence_number_check;

alter table public.session_events
  add constraint session_events_sequence_number_check
  check (sequence_number is null or sequence_number > 0);

create unique index if not exists session_events_source_event_id_idx
  on public.session_events(source, source_event_id)
  where source_event_id is not null;

create index if not exists session_events_session_sequence_idx
  on public.session_events(session_id, sequence_number)
  where sequence_number is not null;

comment on column public.session_events.source is 'System that emitted the event: LiveKit webhook, agent worker, or platform.';
comment on column public.session_events.source_event_id is 'Stable source identifier used to make retries idempotent.';
comment on column public.session_events.received_at is 'When the platform persisted the event; occurred_at is when it happened.';
comment on column public.session_events.sequence_number is 'Optional per-session worker sequence for deterministic ordering.';

alter table public.session_traces
  add column if not exists source text not null default 'agent_worker',
  add column if not exists source_event_id text,
  add column if not exists received_at timestamptz not null default timezone('utc', now()),
  add column if not exists sequence_number bigint;

alter table public.session_traces
  drop constraint if exists session_traces_source_check;

alter table public.session_traces
  add constraint session_traces_source_check
  check (source in ('livekit_webhook', 'agent_worker', 'platform'));

alter table public.session_traces
  drop constraint if exists session_traces_sequence_number_check;

alter table public.session_traces
  add constraint session_traces_sequence_number_check
  check (sequence_number is null or sequence_number > 0);

create unique index if not exists session_traces_source_event_id_idx
  on public.session_traces(source, source_event_id)
  where source_event_id is not null;

create index if not exists session_traces_session_sequence_idx
  on public.session_traces(session_id, sequence_number)
  where sequence_number is not null;

comment on column public.session_traces.source_event_id is 'Stable worker identifier for retry-safe span updates.';
comment on column public.session_traces.received_at is 'When the platform persisted the span; started_at is when the stage began.';

alter table public.session_turns
  add column if not exists status text not null default 'in_progress',
  add column if not exists input_tokens integer not null default 0,
  add column if not exists output_tokens integer not null default 0,
  add column if not exists completed_at timestamptz;

alter table public.session_turns
  drop constraint if exists session_turns_status_check;

alter table public.session_turns
  add constraint session_turns_status_check
  check (status in ('in_progress', 'completed', 'failed', 'cancelled'));

alter table public.session_turns
  drop constraint if exists session_turns_input_tokens_check;

alter table public.session_turns
  add constraint session_turns_input_tokens_check
  check (input_tokens >= 0);

alter table public.session_turns
  drop constraint if exists session_turns_output_tokens_check;

alter table public.session_turns
  add constraint session_turns_output_tokens_check
  check (output_tokens >= 0);

comment on column public.session_turns.status is 'Collection state for the user-agent exchange.';
comment on column public.session_turns.input_tokens is 'LLM input tokens reported for this turn, when available.';
comment on column public.session_turns.output_tokens is 'LLM output tokens reported for this turn, when available.';

alter table public.tool_calls
  add column if not exists trace_id uuid references public.session_traces(id) on delete set null,
  add column if not exists source text not null default 'agent_worker',
  add column if not exists source_event_id text,
  add column if not exists received_at timestamptz not null default timezone('utc', now()),
  add column if not exists sequence_number bigint;

alter table public.tool_calls
  drop constraint if exists tool_calls_source_check;

alter table public.tool_calls
  add constraint tool_calls_source_check
  check (source in ('agent_worker', 'platform'));

alter table public.tool_calls
  drop constraint if exists tool_calls_sequence_number_check;

alter table public.tool_calls
  add constraint tool_calls_sequence_number_check
  check (sequence_number is null or sequence_number > 0);

create unique index if not exists tool_calls_source_event_id_idx
  on public.tool_calls(source, source_event_id)
  where source_event_id is not null;

create index if not exists tool_calls_trace_id_idx on public.tool_calls(trace_id);

comment on column public.tool_calls.trace_id is 'Waterfall span representing this tool execution.';
comment on column public.tool_calls.source_event_id is 'Stable worker identifier used to make tool retries idempotent.';
