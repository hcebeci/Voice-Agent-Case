begin;

alter table public.tool_calls add column event_versions jsonb not null default '{}';

-- One transaction owns both projections. Replayed starts may fill in evidence,
-- but can never reopen a completed call or replace its terminal result.
create function public.observe_tool_event(p_event jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  sid uuid := (p_event->>'session_id')::uuid;
  kind text := p_event->>'event_type';
  at_time timestamptz := (p_event->>'occurred_at')::timestamptz;
  sequence bigint := (p_event->>'sequence_number')::bigint;
  payload jsonb := coalesce(p_event->'payload','{}'::jsonb);
  call_key text := sid::text || ':' || coalesce(payload->>'tool_call_id',p_event->>'event_id');
  version_key text := case when kind='tool.started' then 'start' else 'terminal' end;
  previous jsonb;
  t public.tool_calls;
  span public.session_traces;
  turn uuid;
  reported_duration integer;
  had_call boolean;
begin
  if kind not in ('tool.started','tool.succeeded','tool.failed') then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('observe_tool:' || call_key,0));
  select * into t from public.tool_calls
    where source='agent_worker' and source_event_id=call_key for update;
  had_call := found;
  select * into span from public.session_traces
    where source='agent_worker' and source_event_id=call_key || ':trace' for update;
  select id into turn from public.session_turns where session_id=sid
    and turn_number=(p_event->>'turn_number')::integer;

  if not had_call then
    t.id := gen_random_uuid();
    t.session_id := sid;
    t.tool_name := 'unknown';
    t.arguments := '{}';
    t.status := 'started';
    t.started_at := at_time;
    t.event_versions := '{}';
  end if;
  t.trace_id := coalesce(t.trace_id,span.id,gen_random_uuid());
  t.turn_id := coalesce(t.turn_id,turn);
  previous := t.event_versions->version_key;
  -- Existing pre-migration terminal rows already carry a usable version.
  if previous is null and version_key='terminal' and t.completed_at is not null then
    previous := jsonb_build_object('at',t.completed_at,'sequence',coalesce(t.sequence_number,0));
  end if;
  if previous is not null and ((previous->>'at')::timestamptz > at_time or
    ((previous->>'at')::timestamptz = at_time and
      coalesce((previous->>'sequence')::bigint,0) >= coalesce(sequence,0))) then
    return t.id;
  end if;

  if jsonb_typeof(payload->'duration_ms')='number' and (payload->>'duration_ms')::numeric >= 0 then
    reported_duration := round((payload->>'duration_ms')::numeric)::integer;
  end if;
  t.event_versions := jsonb_set(t.event_versions,array[version_key],
    jsonb_build_object('at',at_time,'sequence',coalesce(sequence,0),'duration_ms',reported_duration));
  if jsonb_typeof(payload->'tool_name')='string' then t.tool_name := payload->>'tool_name'; end if;
  if kind='tool.started' then
    t.started_at := at_time;
    if jsonb_typeof(payload->'arguments')='object' then t.arguments := payload->'arguments'; end if;
  else
    t.status := case when kind='tool.failed' then 'failed' else 'succeeded' end;
    t.completed_at := at_time;
    t.result := payload->'result';
    t.error_message := case when jsonb_typeof(payload->'error_message')='string' then payload->>'error_message' end;
    if not had_call then
      t.started_at := at_time - coalesce(reported_duration,0) * interval '1 millisecond';
      if jsonb_typeof(payload->'arguments')='object' then t.arguments := payload->'arguments'; end if;
    end if;
  end if;
  if t.completed_at is not null then
    t.duration_ms := coalesce((t.event_versions->'terminal'->>'duration_ms')::integer,
      case when t.event_versions ? 'terminal' then null else t.duration_ms end,
      greatest(0,round(extract(epoch from (t.completed_at-t.started_at))*1000)::integer));
  end if;
  t.sequence_number := greatest(t.sequence_number,sequence);

  insert into public.session_traces(id,session_id,turn_id,event_type,started_at,ended_at,
    duration_ms,status,metadata,raw_payload,source,source_event_id,sequence_number)
    values(t.trace_id,sid,t.turn_id,'trace.tool',t.started_at,t.completed_at,t.duration_ms,
      case t.status when 'started' then 'running' when 'failed' then 'failed' else 'completed' end,
      jsonb_build_object('tool_call_id',coalesce(payload->>'tool_call_id',p_event->>'event_id'),
        'tool_name',t.tool_name,'arguments',t.arguments,'result',t.result,'error_message',t.error_message),
      case when kind='tool.started' and t.status <> 'started' then coalesce(span.raw_payload,'{}'::jsonb) else payload end,
      'agent_worker',call_key || ':trace',t.sequence_number)
    on conflict(source,source_event_id) do update set
      turn_id=excluded.turn_id,started_at=excluded.started_at,ended_at=excluded.ended_at,
      duration_ms=excluded.duration_ms,status=excluded.status,metadata=excluded.metadata,
      raw_payload=excluded.raw_payload,sequence_number=excluded.sequence_number;
  insert into public.tool_calls(id,session_id,turn_id,tool_name,status,arguments,result,error_message,
    started_at,completed_at,duration_ms,trace_id,source,source_event_id,sequence_number,event_versions)
    values(t.id,sid,t.turn_id,t.tool_name,t.status,t.arguments,t.result,t.error_message,t.started_at,
      t.completed_at,t.duration_ms,t.trace_id,'agent_worker',call_key,t.sequence_number,t.event_versions)
    on conflict(source,source_event_id) do update set
      turn_id=excluded.turn_id,tool_name=excluded.tool_name,status=excluded.status,
      arguments=excluded.arguments,result=excluded.result,error_message=excluded.error_message,
      started_at=excluded.started_at,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,
      trace_id=excluded.trace_id,sequence_number=excluded.sequence_number,event_versions=excluded.event_versions;
  return t.id;
end $$;
revoke all on function public.observe_tool_event(jsonb) from public,anon,authenticated;
grant execute on function public.observe_tool_event(jsonb) to service_role;
commit;
