-- Agent platform foundation
--
-- This migration creates the single-organization data model for the MVP.
-- Runtime badges are derived instead of stored:
--   offline  = agents.archived_at is not null
--   active   = the agent has at least one active session
--   sleeping = the agent is not archived and has no active session

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  description text not null default '',
  instructions text not null default '',
  model text not null,
  voice text,
  language text not null default 'en',
  tts_model text not null default 'inworld/inworld-tts-2' check (tts_model in ('cartesia/sonic-3', 'inworld/inworld-tts-2')),
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.agents is 'Saved agent configurations for the single platform organization.';
comment on column public.agents.archived_at is 'When set, the agent is offline and cannot receive new sessions.';

drop trigger if exists agents_set_updated_at on public.agents;
create trigger agents_set_updated_at
before update on public.agents
for each row execute function public.set_updated_at();

create table if not exists public.tools (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) between 1 and 80),
  description text not null default '',
  execution_key text not null unique,
  input_schema jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.tools is 'Shared backend-executed tools. No tools are seeded for the initial MVP.';
comment on column public.tools.execution_key is 'Stable backend key used to dispatch execution; never execute arbitrary client-provided code.';

drop trigger if exists tools_set_updated_at on public.tools;
create trigger tools_set_updated_at
before update on public.tools
for each row execute function public.set_updated_at();

create table if not exists public.agent_tools (
  agent_id uuid not null references public.agents(id) on delete cascade,
  tool_id uuid not null references public.tools(id) on delete restrict,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (agent_id, tool_id)
);

comment on table public.agent_tools is 'Tools enabled for an agent and their agent-specific configuration.';

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete restrict,
  room_name text not null unique,
  source text not null check (source in ('user_started', 'platform_started')),
  status text not null default 'connecting' check (status in ('connecting', 'active', 'completed', 'failed', 'cancelled')),
  started_at timestamptz,
  ended_at timestamptz,
  agent_configuration_snapshot jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  check (ended_at is null or started_at is null or ended_at >= started_at)
);

comment on table public.sessions is 'One browser-based LiveKit conversation.';
comment on column public.sessions.agent_configuration_snapshot is 'Configuration copied at session start so later edits do not rewrite session history.';

create index if not exists sessions_agent_id_idx on public.sessions(agent_id);
create index if not exists sessions_status_idx on public.sessions(status);
create index if not exists sessions_started_at_idx on public.sessions(started_at desc);

create table if not exists public.session_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  turn_number integer not null check (turn_number > 0),
  user_transcript text not null default '',
  agent_transcript text not null default '',
  user_speech_stopped_at timestamptz,
  transcript_completed_at timestamptz,
  model_started_at timestamptz,
  model_first_token_at timestamptz,
  model_completed_at timestamptz,
  response_ready_at timestamptz,
  agent_first_audio_started_at timestamptz,
  total_latency_ms integer check (total_latency_ms is null or total_latency_ms >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (session_id, turn_number)
);

comment on table public.session_turns is 'Turn-level transcript and latency timestamps.';
comment on column public.session_turns.total_latency_ms is 'Agent first audio start minus user speech stopped time, including tool execution.';

create index if not exists session_turns_session_id_idx on public.session_turns(session_id, turn_number);
create index if not exists session_turns_latency_idx on public.session_turns(total_latency_ms) where total_latency_ms is not null;

create table if not exists public.session_metrics (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  total_input_tokens integer not null default 0 check (total_input_tokens >= 0),
  total_output_tokens integer not null default 0 check (total_output_tokens >= 0),
  average_latency_ms numeric(12, 2),
  completed_turn_count integer not null default 0 check (completed_turn_count >= 0),
  captured_at timestamptz not null default timezone('utc', now())
);

comment on table public.session_metrics is 'Session-level usage and latency aggregates. Percentiles are calculated from session_turns.';

create table if not exists public.session_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  turn_id uuid references public.session_turns(id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null default timezone('utc', now()),
  payload jsonb not null default '{}'::jsonb
);

comment on table public.session_events is 'Lifecycle and observability events used to build the session timeline.';

create index if not exists session_events_session_time_idx on public.session_events(session_id, occurred_at);

create table if not exists public.session_traces (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  turn_id uuid references public.session_turns(id) on delete cascade,
  parent_trace_id uuid references public.session_traces(id) on delete cascade,
  event_type text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  status text not null default 'completed' check (status in ('running', 'completed', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb
);

comment on table public.session_traces is 'Readable, expandable execution trace events for the session details page.';

create index if not exists session_traces_session_time_idx on public.session_traces(session_id, started_at);
create index if not exists session_traces_turn_time_idx on public.session_traces(turn_id, started_at);

create table if not exists public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  turn_id uuid references public.session_turns(id) on delete cascade,
  tool_id uuid references public.tools(id) on delete set null,
  tool_name text not null,
  status text not null default 'started' check (status in ('started', 'succeeded', 'failed')),
  arguments jsonb not null default '{}'::jsonb,
  result jsonb,
  error_message text,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0)
);

comment on table public.tool_calls is 'Backend tool execution records, including duration and result status.';

create index if not exists tool_calls_session_time_idx on public.tool_calls(session_id, started_at);

-- Keep public tables private to authenticated application users.
-- This is intentionally a single-organization policy for the MVP.
alter table public.agents enable row level security;
alter table public.tools enable row level security;
alter table public.agent_tools enable row level security;
alter table public.sessions enable row level security;
alter table public.session_turns enable row level security;
alter table public.session_metrics enable row level security;
alter table public.session_events enable row level security;
alter table public.session_traces enable row level security;
alter table public.tool_calls enable row level security;

drop policy if exists authenticated_agents on public.agents;
create policy authenticated_agents on public.agents
for all to authenticated using (true) with check (true);

drop policy if exists authenticated_tools on public.tools;
create policy authenticated_tools on public.tools
for all to authenticated using (true) with check (true);

drop policy if exists authenticated_agent_tools on public.agent_tools;
create policy authenticated_agent_tools on public.agent_tools
for all to authenticated using (true) with check (true);

drop policy if exists authenticated_sessions on public.sessions;
create policy authenticated_sessions on public.sessions
for all to authenticated using (true) with check (true);

drop policy if exists authenticated_session_turns on public.session_turns;
create policy authenticated_session_turns on public.session_turns
for all to authenticated using (true) with check (true);

drop policy if exists authenticated_session_metrics on public.session_metrics;
create policy authenticated_session_metrics on public.session_metrics
for all to authenticated using (true) with check (true);

drop policy if exists authenticated_session_events on public.session_events;
create policy authenticated_session_events on public.session_events
for all to authenticated using (true) with check (true);

drop policy if exists authenticated_session_traces on public.session_traces;
create policy authenticated_session_traces on public.session_traces
for all to authenticated using (true) with check (true);

drop policy if exists authenticated_tool_calls on public.tool_calls;
create policy authenticated_tool_calls on public.tool_calls
for all to authenticated using (true) with check (true);
