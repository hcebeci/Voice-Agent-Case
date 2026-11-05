\set ON_ERROR_STOP on
-- This file is run exclusively by the temporary-cluster test runner.
insert into auth.users(id) values ('10000000-0000-0000-0000-000000000001'),('10000000-0000-0000-0000-000000000002');
insert into public.agents(id,name,model,created_by) values('20000000-0000-0000-0000-000000000001','before','model','10000000-0000-0000-0000-000000000001');
insert into public.tools(id,name,execution_key) values('30000000-0000-0000-0000-000000000001','test tool','test_tool');
insert into public.agent_tools(agent_id,tool_id) values('20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001');
insert into public.sessions(id,agent_id,room_name,source,status,created_by,started_at,last_livekit_event_at)
 values('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','test-room','user_started','active','10000000-0000-0000-0000-000000000001',now()-interval '20 minutes',now()-interval '20 minutes');

alter table public.agent_tools add constraint regression_insert_failure check (configuration <> '{"fail":true}'::jsonb);

set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
do $$
declare t text;
begin
  foreach t in array array['sessions','session_turns','session_metrics','session_events','session_traces','tool_calls','agent_change_events','livekit_webhook_events'] loop
    if not has_table_privilege(current_user,'public.'||t,'SELECT') then raise exception 'Missing browser read: %',t; end if;
    if has_table_privilege(current_user,'public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE') then raise exception 'Browser can write runtime table: %',t; end if;
    begin
      execute format('delete from public.%I',t);
      raise exception 'Delete unexpectedly succeeded on %',t;
    exception when insufficient_privilege then null; end;
  end loop;
  if has_table_privilege(current_user,'public.agents','DELETE') or has_table_privilege(current_user,'public.tools','DELETE') then raise exception 'Archive-only configuration deletion bypass'; end if;
  if has_function_privilege(current_user,'public.close_browser_session(uuid,uuid,text)','EXECUTE') then raise exception 'Browser can supply a forged owner'; end if;
  -- A failed save must preserve both old agent fields and its previous tools.
  begin
    perform public.save_agent('20000000-0000-0000-0000-000000000001','{"name":"must roll back"}',
      '[{"tool_id":"30000000-0000-0000-0000-000000000099"}]');
    raise exception 'Invalid save unexpectedly succeeded';
  exception when invalid_parameter_value then null; end;
  if (select name from public.agents where id='20000000-0000-0000-0000-000000000001') <> 'before' then raise exception 'Partial agent save'; end if;
  if (select count(*) from public.agent_tools where agent_id='20000000-0000-0000-0000-000000000001') <> 1 then raise exception 'Assignments lost'; end if;
  -- Force an insertion failure after deletion, exercising transaction rollback.
  begin
    perform public.save_agent('20000000-0000-0000-0000-000000000001','{"name":"must roll back after delete"}',
      '[{"tool_id":"30000000-0000-0000-0000-000000000001","configuration":{"fail":true}}]');
    raise exception 'Failing insert unexpectedly succeeded';
  exception when check_violation then null; end;
  if (select name from public.agents where id='20000000-0000-0000-0000-000000000001') <> 'before' then raise exception 'Insert failure left partial agent save'; end if;
  if (select count(*) from public.agent_tools where agent_id='20000000-0000-0000-0000-000000000001') <> 1 then raise exception 'Insert failure lost old assignments'; end if;
  perform public.save_agent('20000000-0000-0000-0000-000000000001','{"name":"after"}','[]');
  if exists(select 1 from public.agent_tools where agent_id='20000000-0000-0000-0000-000000000001') then raise exception 'Explicit empty assignments ignored'; end if;
  if not exists(select 1 from public.agent_change_events where agent_id='20000000-0000-0000-0000-000000000001' and new_values->>'name'='after' and changed_by=auth.uid()) then raise exception 'Missing actor audit'; end if;
  perform public.save_agent('20000000-0000-0000-0000-000000000001','{"tts_model":"cartesia/sonic-3"}');
  if not exists(select 1 from public.agent_change_events where agent_id='20000000-0000-0000-0000-000000000001'
    and changed_fields=array['tts_model'] and previous_values->>'tts_model'='inworld/inworld-tts-2'
    and new_values->>'tts_model'='cartesia/sonic-3' and changed_by=auth.uid()) then raise exception 'Missing TTS model audit'; end if;

end $$;
reset role;

set role service_role;
do $$
declare r jsonb; ended timestamptz;
begin
  r:=public.close_browser_session('10000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001','completed');
  if r->>'code' <> 'SESSION_NOT_FOUND' then raise exception 'Cross-user close accepted'; end if;
  r:=public.close_browser_session('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','active');
  if r->>'code' <> 'INVALID_TRANSITION' then raise exception 'Browser activation accepted'; end if;
  r:=public.close_browser_session('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','completed');
  if r->'session'->>'status' <> 'completed' then raise exception 'Close failed'; end if;
  ended:=(r->'session'->>'ended_at')::timestamptz;
  r:=public.close_browser_session('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','completed');
  if (r->'session'->>'ended_at')::timestamptz <> ended then raise exception 'Replay rewrote end time'; end if;
  r:=public.close_browser_session('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','failed');
  if r->>'code' <> 'SESSION_CLOSED' then raise exception 'Terminal state changed'; end if;
end $$;
reset role;

alter table public.agent_tools drop constraint regression_insert_failure;
