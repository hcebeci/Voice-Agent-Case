-- Agent audit history
--
-- This migration records every agent creation, edit, archive, and restore.
-- Agents are archived instead of hard-deleted so their history and sessions
-- remain available.

create table if not exists public.agent_change_events (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents(id) on delete set null,
  changed_by uuid references auth.users(id) on delete set null,
  change_type text not null check (change_type in ('created', 'updated', 'archived', 'restored')),
  changed_fields text[] not null default '{}',
  previous_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc', now())
);

comment on table public.agent_change_events is 'Append-only audit history for saved agent configuration changes.';
comment on column public.agent_change_events.changed_fields is 'Agent fields that changed in this event, excluding automatic timestamps.';
comment on column public.agent_change_events.previous_values is 'Values before the change for the tracked agent fields.';
comment on column public.agent_change_events.new_values is 'Values after the change for the tracked agent fields.';

create index if not exists agent_change_events_agent_time_idx
on public.agent_change_events(agent_id, occurred_at desc);

create index if not exists agent_change_events_changed_by_time_idx
on public.agent_change_events(changed_by, occurred_at desc);

create or replace function public.record_agent_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tracked_fields text[] := array[
    'name',
    'description',
    'instructions',
    'model',
    'voice',
    'language',
    'archived_at'
  ];
  changed_fields text[] := '{}';
  previous_values jsonb := '{}'::jsonb;
  new_values jsonb := '{}'::jsonb;
  current_field text;
  change_type text;
begin
  if tg_op = 'INSERT' then
    change_type := 'created';
    changed_fields := tracked_fields;
    previous_values := '{}'::jsonb;
    new_values := jsonb_build_object(
      'name', new.name,
      'description', new.description,
      'instructions', new.instructions,
      'model', new.model,
      'voice', new.voice,
      'language', new.language,
      'archived_at', new.archived_at
    );
  else
    if old.archived_at is null and new.archived_at is not null then
      change_type := 'archived';
    elsif old.archived_at is not null and new.archived_at is null then
      change_type := 'restored';
    else
      change_type := 'updated';
    end if;

    foreach current_field in array tracked_fields loop
      if (to_jsonb(old) -> current_field) is distinct from (to_jsonb(new) -> current_field) then
        changed_fields := array_append(changed_fields, current_field);
        previous_values := previous_values || jsonb_build_object(current_field, to_jsonb(old) -> current_field);
        new_values := new_values || jsonb_build_object(current_field, to_jsonb(new) -> current_field);
      end if;
    end loop;

    -- Ignore updates that only changed updated_at or another internal column.
    if cardinality(changed_fields) = 0 then
      return new;
    end if;
  end if;

  insert into public.agent_change_events (
    agent_id,
    changed_by,
    change_type,
    changed_fields,
    previous_values,
    new_values
  ) values (
    new.id,
    auth.uid(),
    change_type,
    changed_fields,
    previous_values,
    new_values
  );

  return new;
end;
$$;

drop trigger if exists agents_record_change on public.agents;
create trigger agents_record_change
after insert or update on public.agents
for each row execute function public.record_agent_change();

-- Preserve a creation event for agents that existed before this migration.
insert into public.agent_change_events (
  agent_id,
  changed_by,
  change_type,
  changed_fields,
  previous_values,
  new_values,
  occurred_at
)
select
  agents.id,
  agents.created_by,
  'created',
  array['name', 'description', 'instructions', 'model', 'voice', 'language', 'archived_at'],
  '{}'::jsonb,
  jsonb_build_object(
    'name', agents.name,
    'description', agents.description,
    'instructions', agents.instructions,
    'model', agents.model,
    'voice', agents.voice,
    'language', agents.language,
    'archived_at', agents.archived_at
  ),
  agents.created_at
from public.agents
where not exists (
  select 1
  from public.agent_change_events history
  where history.agent_id = agents.id
    and history.change_type = 'created'
);

alter table public.agent_change_events enable row level security;

drop policy if exists authenticated_agent_change_events_select on public.agent_change_events;
create policy authenticated_agent_change_events_select on public.agent_change_events
for select to authenticated using (true);
