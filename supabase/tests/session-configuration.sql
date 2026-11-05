\set ON_ERROR_STOP on
insert into auth.users(id) values('70000000-0000-0000-0000-000000000001');
insert into public.agents(id,name,instructions,model,created_by) values('70000000-0000-0000-0000-000000000002','Current saved name','Current instructions','current-model','70000000-0000-0000-0000-000000000001');
insert into public.customers(id,full_name,date_of_birth,postal_code,account_reference,balance_cents,payment_due_date,is_test_record)
 values('70000000-0000-0000-0000-000000000003','SQL fixture','1990-01-01','00000','SQL-COHERENT',1000,current_date,true);
set role authenticated;
select set_config('request.jwt.claim.sub','70000000-0000-0000-0000-000000000001',false);
do $$
begin
  if has_function_privilege(current_user,'public.session_start_reserve(uuid,text,jsonb,jsonb)','EXECUTE') then raise exception 'Browser can forge session snapshot'; end if;
  if has_table_privilege(current_user,'public.agent_tools','INSERT,UPDATE,DELETE') then raise exception 'Browser can bypass assignment lock'; end if;
  perform public.replace_agent_assignments('70000000-0000-0000-0000-000000000002',
    (select jsonb_agg(jsonb_build_object('tool_id',id)) from public.tools where execution_key='evaluate_offer'));
end $$;
reset role;
set role service_role;
do $$
declare payload jsonb := '{"agent_id":"70000000-0000-0000-0000-000000000002","source":"user_started","call_direction":"agent_calls_user","customer_id":"70000000-0000-0000-0000-000000000003"}'; r jsonb;
begin
  r:=public.session_start_reserve('70000000-0000-0000-0000-000000000001','sql-prerequisite',payload,'{}');
  if r->>'code' <> 'AGENT_TOOL_PREREQUISITES' then raise exception 'Missing payment prerequisite accepted: %',r; end if;
  if exists(select 1 from public.session_start_requests where request_key='sql-prerequisite') then raise exception 'Invalid configuration reserved call'; end if;
end $$;
reset role;
set role authenticated;
select public.save_agent('70000000-0000-0000-0000-000000000002','{"name":"Coherent saved name","instructions":"Coherent saved instructions"}',
 (select jsonb_agg(jsonb_build_object('tool_id',id)) from public.tools where execution_key in ('verify_identity','evaluate_offer')));
reset role;
set role service_role;
do $$
declare payload jsonb := '{"agent_id":"70000000-0000-0000-0000-000000000002","source":"user_started","call_direction":"agent_calls_user","customer_id":"70000000-0000-0000-0000-000000000003"}'; r jsonb;
begin
  r:=public.session_start_reserve('70000000-0000-0000-0000-000000000001','sql-coherent-call',payload,
    '{"name":"Stale prefetch","model":"stale-model","enabled_tools":["request_callback"],"customer_id":"forged"}');
  if r ? 'code' then raise exception 'Reservation failed: %',r; end if;
  if r->'snapshot'->>'name' <> 'Coherent saved name' or r->'snapshot'->>'model' <> 'current-model'
    or r->'snapshot'->>'instructions' <> 'Coherent saved instructions' then raise exception 'Trusted stale Edge snapshot'; end if;
  if not ((r->'snapshot'->'enabled_tools') @> '["verify_identity","evaluate_offer"]'::jsonb)
    or jsonb_array_length(r->'snapshot'->'enabled_tools') <> 2 then raise exception 'Wrong saved assignments'; end if;
  if r->'snapshot'->>'customer_id' <> payload->>'customer_id'
    or not exists(select 1 from public.collection_sessions where session_id=(r->>'session_id')::uuid and customer_id=(payload->>'customer_id')::uuid)
    or not exists(select 1 from public.sessions where id=(r->>'session_id')::uuid and source='platform_started') then raise exception 'Lost binding or direction'; end if;
end $$;
reset role;
-- Editing/archiving afterward must not invalidate an already reserved attempt.
set role authenticated;
select public.save_agent('70000000-0000-0000-0000-000000000002','{"name":"Later archived name","archived_at":"2026-11-05T00:00:00Z"}','[]');
reset role;
set role service_role;
do $$
declare payload jsonb := '{"agent_id":"70000000-0000-0000-0000-000000000002","source":"user_started","call_direction":"agent_calls_user","customer_id":"70000000-0000-0000-0000-000000000003"}'; r jsonb;
begin
  r:=public.session_start_reserve('70000000-0000-0000-0000-000000000001','sql-coherent-call',payload,'{}');
  if r->'snapshot'->>'name' <> 'Coherent saved name' or jsonb_array_length(r->'snapshot'->'enabled_tools') <> 2 then raise exception 'Replay overwrote original snapshot'; end if;
  r:=public.session_start_reserve('70000000-0000-0000-0000-000000000001','sql-new-archived',payload,'{}');
  if r->>'code' <> 'AGENT_OFFLINE' then raise exception 'Archived agent accepted new call'; end if;
  r:=public.session_start_reserve('70000000-0000-0000-0000-000000000001','sql-coherent-call',payload || '{"call_direction":"user_calls_agent"}','{}');
  if r->>'code' <> 'IDEMPOTENCY_KEY_REUSED' then raise exception 'Changed request payload replayed'; end if;
end $$;
reset role;
