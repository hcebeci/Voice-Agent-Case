-- Integration assertions. Run after migrations and customer seed. Leaves no test rows.
begin;
do $$
declare
  aid uuid := gen_random_uuid();
  sid uuid := gen_random_uuid();
  cid uuid;
  updated timestamptz;
  snapshot jsonb;
  state jsonb;
  result jsonb;
  receipt jsonb;
  effect jsonb;
  pid uuid := gen_random_uuid();
  commitment_id uuid := gen_random_uuid();
begin
  select id, updated_at into strict cid, updated from public.customers where account_reference='DEMO-001';
  insert into public.agents(id,name,model) values(aid,'Collection integration fixture','test');
  insert into public.sessions(id,agent_id,room_name,source,status) values(sid,aid,'test-'||sid,'user_started','active');
  insert into public.collection_sessions(session_id,customer_id) values(sid,cid);
  snapshot := public.collection_snapshot(sid,'commit-test');
  if snapshot->>'session_status' <> 'active' then raise exception 'snapshot failed'; end if;
  state := (snapshot->'state') || jsonb_build_object('verified',true,'customer_updated_at',updated);
  result := jsonb_build_object('tool_name','create_payment_commitment','status','success','code','COMMITMENT_CREATED','verified_user',true,'data',jsonb_build_object('commitment_id',commitment_id));
  effect := jsonb_build_object('kind','commitment','commitment_id',commitment_id,'proposal_id',pid,'amount_cents',85000,'currency','USD','payment_date','2026-10-05','confirmation_turn_id','actual-user-turn','policy_version','collection-demo-v1');
  receipt := public.collection_commit(sid,'commit-test',0,state,result,effect,'{}');
  if receipt->'result' <> result then raise exception 'receipt mismatch'; end if;
  receipt := public.collection_commit(sid,'commit-test',0,state,result,effect,'{}');
  if (select count(*) from public.payment_commitments where session_id=sid) <> 1 then raise exception 'duplicate commitment'; end if;
  if (select count(*) from public.session_events where session_id=sid) <> 1 then raise exception 'duplicate audit'; end if;
  if (select balance_cents from public.customers where id=cid) <> 200000 then raise exception 'balance changed'; end if;
  receipt := public.collection_commit(sid,'stale',0,state,result,null,'{}');
  if receipt->>'conflict' <> 'true' then raise exception 'stale version accepted'; end if;
  -- Failure during business write must not leave a receipt, state change or audit.
  begin
    perform public.collection_commit(sid,'invalid-write',1,state,result,
      effect || jsonb_build_object('commitment_id',gen_random_uuid(),'proposal_id',gen_random_uuid(),'amount_cents',-1),'{}');
    raise exception 'negative amount unexpectedly accepted';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.collection_operations where session_id=sid and request_id='invalid-write') then raise exception 'failed write saved receipt'; end if;
  if (select version from public.collection_sessions where session_id=sid) <> 1 then raise exception 'failed write changed state'; end if;
  -- Redaction remains enforced in SQL even if caller accidentally supplies answers.
  perform public.collection_commit(sid,'verify-log',1,state,
    jsonb_build_object('tool_name','verify_identity','status','rejected','code','IDENTITY_NOT_VERIFIED','verified_user',true,'data','{}'::jsonb),
    null,'{"date_of_birth":"1988-04-12","postal_code":"34000"}');
  if exists(select 1 from public.session_events where session_id=sid and payload::text like '%1988-04-12%') then raise exception 'verification leaked'; end if;
  update public.sessions set status='completed' where id=sid;
  receipt := public.collection_commit(sid,'closed',2,state,result,effect,'{}');
  if receipt->'result'->>'code' <> 'SESSION_NOT_ACTIVE' then raise exception 'ended session allowed'; end if;
  if has_function_privilege('authenticated','public.collection_commit(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb)','EXECUTE')
     or has_table_privilege('authenticated','public.collection_sessions','UPDATE') then raise exception 'browser can mutate trusted state'; end if;
end;
$$;
rollback;
