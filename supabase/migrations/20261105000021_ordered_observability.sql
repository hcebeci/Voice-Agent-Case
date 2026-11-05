-- Serialize turn projections and derive latency after either timestamp arrives.
begin;
alter table public.session_turns add column event_versions jsonb not null default '{}';

create function public.observe_turn_event(p_event jsonb)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  t public.session_turns;
  kind text := p_event->>'event_type';
  sid uuid := (p_event->>'session_id')::uuid;
  n integer := (p_event->>'turn_number')::integer;
  at_time timestamptz := (p_event->>'occurred_at')::timestamptz;
  sequence bigint := coalesce((p_event->>'sequence_number')::bigint,0);
  payload jsonb := p_event->'payload';
  version_key text;
  previous jsonb;
begin
  if n is null then return null; end if;
  if kind not in ('turn.user_speech_stopped','turn.transcript_completed','turn.response_ready','turn.agent_audio_started','turn.completed','turn.cancelled') then return null; end if;
  insert into session_turns(session_id,turn_number) values(sid,n) on conflict(session_id,turn_number) do nothing;
  select * into strict t from session_turns where session_id=sid and turn_number=n for update;
  version_key := case when kind in ('turn.completed','turn.cancelled') then 'lifecycle' else kind end;
  previous := t.event_versions->version_key;
  if previous is not null and ((previous->>'at')::timestamptz > at_time or
    ((previous->>'at')::timestamptz = at_time and (previous->>'sequence')::bigint >= sequence)) then
    return t.id;
  end if;
  t.event_versions := jsonb_set(t.event_versions,array[version_key],jsonb_build_object('at',at_time,'sequence',sequence));
  case kind
    when 'turn.user_speech_stopped' then t.user_speech_stopped_at := at_time;
    when 'turn.transcript_completed' then
      t.user_transcript := case when jsonb_typeof(payload->'transcript')='string' then payload->>'transcript' else '' end;
      t.transcript_completed_at := at_time;
    when 'turn.response_ready' then
      t.agent_transcript := case when jsonb_typeof(payload->'transcript')='string' then payload->>'transcript' else '' end;
      t.response_ready_at := at_time;
    when 'turn.agent_audio_started' then t.agent_first_audio_started_at := at_time;
    when 'turn.completed' then t.status := 'completed'; t.completed_at := at_time;
    when 'turn.cancelled' then t.status := 'cancelled'; t.completed_at := at_time;
  end case;
  t.total_latency_ms := case when t.agent_first_audio_started_at >= t.user_speech_stopped_at
    then round(extract(epoch from (t.agent_first_audio_started_at-t.user_speech_stopped_at))*1000)::integer else null end;
  update session_turns set
    user_speech_stopped_at=t.user_speech_stopped_at,user_transcript=t.user_transcript,
    transcript_completed_at=t.transcript_completed_at,agent_transcript=t.agent_transcript,
    response_ready_at=t.response_ready_at,agent_first_audio_started_at=t.agent_first_audio_started_at,
    total_latency_ms=t.total_latency_ms,status=t.status,completed_at=t.completed_at,event_versions=t.event_versions
    where id=t.id;
  return t.id;
end $$;

create function public.observe_session_usage(p_session_id uuid,p_input integer,p_output integer,p_occurred_at timestamptz)
returns void language sql security invoker set search_path=public,pg_temp as $$
  insert into session_metrics(session_id,total_input_tokens,total_output_tokens,captured_at)
    values(p_session_id,p_input,p_output,p_occurred_at)
  on conflict(session_id) do update set
    total_input_tokens=greatest(session_metrics.total_input_tokens,excluded.total_input_tokens),
    total_output_tokens=greatest(session_metrics.total_output_tokens,excluded.total_output_tokens),
    captured_at=greatest(session_metrics.captured_at,excluded.captured_at);
$$;
revoke all on function public.observe_turn_event(jsonb),public.observe_session_usage(uuid,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.observe_turn_event(jsonb),public.observe_session_usage(uuid,integer,integer,timestamptz) to service_role;
commit;
