\set ON_ERROR_STOP on
begin;
insert into public.agents(id,name,model) values('60000000-0000-0000-0000-000000000001','Tool ordering regression','synthetic');
insert into public.sessions(id,agent_id,room_name,source,status) values
  ('60000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000001','tool-ordering-regression','user_started','completed');
create function pg_temp.tool_event(kind text,at_time text,seq integer,payload jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('event_id',gen_random_uuid(),'session_id','60000000-0000-0000-0000-000000000002',
    'event_type',kind,'occurred_at',at_time,'sequence_number',seq,'payload',payload);
$$;
do $$
declare t public.tool_calls; span public.session_traces; original_id uuid; original_trace uuid;
begin
  if has_function_privilege('authenticated','public.observe_tool_event(jsonb)','EXECUTE')
    or has_function_privilege('anon','public.observe_tool_event(jsonb)','EXECUTE') then
    raise exception 'Browser can write tool projections';
  end if;
  perform public.observe_tool_event(pg_temp.tool_event('tool.succeeded','2026-11-05T10:00:02Z',2,
    '{"tool_call_id":"reverse","tool_name":"evaluate_offer","result":{"accepted":true},"duration_ms":2000}'));
  select id,trace_id into original_id,original_trace from public.tool_calls where source_event_id like '%:reverse';
  perform public.observe_tool_event(pg_temp.tool_event('tool.started','2026-11-05T10:00:00Z',1,
    '{"tool_call_id":"reverse","tool_name":"evaluate_offer","arguments":{"amount":25}}'));
  select * into strict t from public.tool_calls where id=original_id;
  select * into strict span from public.session_traces where id=t.trace_id;
  if t.status <> 'succeeded' or span.status <> 'completed' or t.trace_id <> original_trace
    or t.arguments <> '{"amount":25}'::jsonb or span.metadata->'arguments' <> t.arguments
    or t.result <> '{"accepted":true}'::jsonb or t.duration_ms <> 2000
    or t.started_at <> '2026-11-05T10:00:00Z'::timestamptz or span.ended_at <> t.completed_at then
    raise exception 'Late start corrupted terminal evidence: % / %',row_to_json(t),row_to_json(span);
  end if;
  -- Older terminal revisions cannot replace newer results, even with larger sequence.
  perform public.observe_tool_event(pg_temp.tool_event('tool.failed','2026-11-05T10:00:01Z',3,
    '{"tool_call_id":"reverse","error_message":"stale"}'));
  if (select status from public.tool_calls where id=original_id) <> 'succeeded' then
    raise exception 'Older terminal overwrote result';
  end if;
  -- A newer same-time correction is accepted, and retries keep the same two IDs.
  for i in 1..3 loop
    perform public.observe_tool_event(pg_temp.tool_event('tool.failed','2026-11-05T10:00:02Z',4,
      '{"tool_call_id":"reverse","tool_name":"evaluate_offer","error_message":"corrected failure"}'));
  end loop;
  select * into strict t from public.tool_calls where id=original_id;
  select * into strict span from public.session_traces where id=original_trace;
  if t.status <> 'failed' or span.status <> 'failed' or t.error_message <> 'corrected failure'
    or t.trace_id <> original_trace or t.sequence_number <> 4
    or (select count(*) from public.tool_calls where session_id=t.session_id) <> 1
    or (select count(*) from public.session_traces where session_id=t.session_id) <> 1 then
    raise exception 'Correction/retry did not preserve one coherent tool/trace';
  end if;
end $$;

-- A failed second projection must roll back the first projection too.
create function pg_temp.fail_tool_insert() returns trigger language plpgsql as $$
begin raise exception 'synthetic tool insert failure' using errcode='23514'; end $$;
create trigger test_tool_insert_failure before insert on public.tool_calls
for each row execute function pg_temp.fail_tool_insert();
do $$
begin
  begin
    perform public.observe_tool_event(pg_temp.tool_event('tool.started','2026-11-05T10:01:00Z',5,
      '{"tool_call_id":"rollback","tool_name":"request_callback"}'));
    raise exception 'Injected failure did not occur';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.session_traces where source_event_id like '%:rollback:trace') then
    raise exception 'Tool failure left a partially written trace';
  end if;
end $$;
rollback;
