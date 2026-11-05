-- Retained synthetic validation evidence. No delete/reset is part of this feature.
begin;
create table public.test_runs (
  id uuid primary key,
  scenario_id text not null,
  scenario_name text not null,
  execution_type text not null check (execution_type in ('manual_audio','automated_scripted','automated_text','automated_audio','integration')),
  status text not null check (status in ('passed','failed','inconclusive','not_run')),
  session_id uuid references public.sessions(id) on delete restrict,
  agent_id uuid references public.agents(id) on delete restrict,
  configuration_version text not null,
  policy_version text not null,
  configuration_snapshot jsonb not null default '{}',
  customer_snapshot jsonb not null check (customer_snapshot @> '{"is_test_record":true}'::jsonb),
  expected_outcome jsonb not null,
  actual_outcome jsonb not null,
  transcript jsonb not null default '[]',
  latency jsonb not null default '{}',
  assertions jsonb not null default '[]',
  provenance jsonb not null default '{}',
  error_message text,
  artifact_path text,
  notes text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  report_hash text not null,
  check (jsonb_typeof(transcript) = 'array'),
  check (jsonb_typeof(assertions) = 'array'),
  check (completed_at is null or started_at is null or completed_at >= started_at)
);
create index test_runs_history_idx on public.test_runs(created_at desc,id desc);
create index test_runs_scenario_idx on public.test_runs(scenario_id,created_at desc);
alter table public.test_runs enable row level security;
revoke all on public.test_runs from public,anon,authenticated,service_role;
grant select on public.test_runs to authenticated;
grant select,insert on public.test_runs to service_role;
create policy test_runs_read on public.test_runs for select to authenticated using (true);
comment on table public.test_runs is 'Append-only application validation history. Includes uncensored fictional customer data. Execution type identifies evidence, not just verdict.';
commit;
