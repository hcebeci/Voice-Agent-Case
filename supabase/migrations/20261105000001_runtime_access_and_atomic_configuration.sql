begin;

-- Dashboard users can inspect runtime evidence; only trusted backend writers own it.
do $$
declare table_name text;
begin
  foreach table_name in array array['sessions','session_turns','session_metrics','session_events','session_traces','tool_calls'] loop
    execute format('drop policy if exists %I on public.%I', 'authenticated_' || table_name, table_name);
    execute format('create policy %I on public.%I for select to authenticated using (true)', 'authenticated_' || table_name, table_name);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
  end loop;
end $$;
revoke insert, update, delete, truncate, references, trigger on public.agent_change_events, public.livekit_webhook_events from public, anon, authenticated;
grant select on public.agent_change_events, public.livekit_webhook_events to authenticated;
-- Configuration deletion uses archive/disable APIs; keep existing history reachable.
revoke delete, truncate on public.agents, public.tools from public, anon, authenticated;

-- Single-workspace editing remains intentional. Lock the agent before replacing
-- assignments so a failed insert or a concurrent save cannot expose an empty set.
create function public.replace_agent_assignments(p_agent_id uuid, p_assignments jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare assignment jsonb;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='42501'; end if;
  if jsonb_typeof(p_assignments) is distinct from 'array' then raise exception 'INVALID_ASSIGNMENTS' using errcode='22023'; end if;
  perform 1 from public.agents where id=p_agent_id for update;
  if not found then raise exception 'AGENT_NOT_FOUND' using errcode='P0002'; end if;
  if exists (select 1 from jsonb_array_elements(p_assignments) a
    where jsonb_typeof(a) <> 'object' or a->>'tool_id' is null
      or (a ? 'configuration' and a->'configuration' <> 'null'::jsonb and jsonb_typeof(a->'configuration') <> 'object')) then
    raise exception 'INVALID_ASSIGNMENTS' using errcode='22023';
  end if;
  if (select count(*) from jsonb_array_elements(p_assignments)) <>
     (select count(distinct a->>'tool_id') from jsonb_array_elements(p_assignments) a) then
    raise exception 'DUPLICATE_ASSIGNMENTS' using errcode='22023';
  end if;
  -- Lock enabled tools so disabling them cannot race validation and insertion.
  for assignment in select value from jsonb_array_elements(p_assignments) order by value->>'tool_id' loop
    perform 1 from public.tools where id=(assignment->>'tool_id')::uuid and is_enabled for share;
    if not found then raise exception 'TOOL_NOT_ENABLED' using errcode='22023'; end if;
  end loop;
  delete from public.agent_tools where agent_id=p_agent_id;
  insert into public.agent_tools(agent_id,tool_id,configuration)
    select p_agent_id,(a->>'tool_id')::uuid,coalesce(nullif(a->'configuration','null'::jsonb),'{}'::jsonb)
    from jsonb_array_elements(p_assignments) a;
end $$;
revoke all on function public.replace_agent_assignments(uuid,jsonb) from public,anon;
grant execute on function public.replace_agent_assignments(uuid,jsonb) to authenticated;

-- Configuration, assignment replacement, and the existing audit trigger commit
-- together. Null assignments means preserve; [] explicitly removes every tool.
create function public.save_agent(p_agent_id uuid, p_fields jsonb, p_assignments jsonb default null)
returns public.agents language plpgsql security invoker set search_path = '' as $$
declare saved public.agents; candidate public.agents;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='42501'; end if;
  if jsonb_typeof(p_fields) is distinct from 'object' or exists (
    select 1 from jsonb_object_keys(p_fields) k where k not in
      ('name','description','instructions','model','voice','language','tts_model','archived_at')) then
    raise exception 'INVALID_AGENT_FIELDS' using errcode='22023';
  end if;
  if p_agent_id is null then
    candidate := jsonb_populate_record(null::public.agents,p_fields);
    insert into public.agents(name,description,instructions,model,voice,language,tts_model,created_by)
      values(candidate.name,coalesce(candidate.description,''),coalesce(candidate.instructions,''),candidate.model,
        candidate.voice,coalesce(candidate.language,'en'),coalesce(candidate.tts_model,'inworld/inworld-tts-2'),auth.uid())
      returning * into saved;
  else
    select * into saved from public.agents where id=p_agent_id for update;
    if not found then raise exception 'AGENT_NOT_FOUND' using errcode='P0002'; end if;
    candidate := jsonb_populate_record(saved,p_fields);
    update public.agents set name=candidate.name, description=candidate.description,
      instructions=candidate.instructions,model=candidate.model,voice=candidate.voice,
      language=candidate.language,tts_model=candidate.tts_model,archived_at=candidate.archived_at
      where id=p_agent_id returning * into saved;
  end if;
  if p_assignments is not null then perform public.replace_agent_assignments(saved.id,p_assignments); end if;
  return saved;
end $$;
revoke all on function public.save_agent(uuid,jsonb,jsonb) from public,anon;
grant execute on function public.save_agent(uuid,jsonb,jsonb) to authenticated;

-- The user ID comes exclusively from the Edge Function's verified JWT context.
-- Browsers may close their own calls, never reopen a terminal call or set clocks.
create function public.close_browser_session(p_user_id uuid,p_session_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.sessions;
begin
  if p_status not in ('completed','failed','cancelled') or p_status is null then
    return jsonb_build_object('code','INVALID_TRANSITION');
  end if;
  select * into s from public.sessions where id=p_session_id and created_by=p_user_id for update;
  if not found then return jsonb_build_object('code','SESSION_NOT_FOUND'); end if;
  if s.status in ('completed','failed','cancelled') then
    if s.status <> p_status then return jsonb_build_object('code','SESSION_CLOSED'); end if;
  else
    update public.sessions set status=p_status,ended_at=greatest(clock_timestamp(),s.started_at)
      where id=p_session_id returning * into s;
  end if;
  return jsonb_build_object('session',jsonb_build_object('id',s.id,'status',s.status,'started_at',s.started_at,'ended_at',s.ended_at));
end $$;
revoke all on function public.close_browser_session(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.close_browser_session(uuid,uuid,text) to service_role;
commit;
