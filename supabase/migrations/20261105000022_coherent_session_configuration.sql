begin;
-- Assignment writes must use the validated editor RPC and its agent row lock.
-- Direct agent UPDATE already acquires that row lock automatically.
revoke insert,update,delete,truncate on public.agent_tools from public,anon,authenticated;
alter function public.replace_agent_assignments(uuid,jsonb) security definer;

-- Keep the old signature for a coordinated rollout, but never trust p_snapshot.
-- Only new attempts read current configuration; retries retain their first capture.
create or replace function public.session_start_reserve(p_user_id uuid,p_key text,p_payload jsonb,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.session_start_requests;
  s public.sessions;
  a public.agents;
  tool record;
  keys text[] := '{}';
  snapshot jsonb;
  sid uuid;
  direction text := coalesce(p_payload->>'call_direction','user_calls_agent');
begin
  if p_user_id is null or p_key is null or char_length(p_key) not between 8 and 200
    or jsonb_typeof(p_payload) is distinct from 'object'
    or p_payload->>'source' is distinct from 'user_started'
    or direction not in ('agent_calls_user','user_calls_agent') then
    return jsonb_build_object('code','INVALID_SESSION_REQUEST');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_key,0));
  select * into r from public.session_start_requests where user_id=p_user_id and request_key=p_key;
  if found then
    if r.request_payload <> p_payload then return jsonb_build_object('code','IDEMPOTENCY_KEY_REUSED'); end if;
  else
    -- Atomic editor saves acquire this same lock before changing fields/tools.
    select * into a from public.agents where id=(p_payload->>'agent_id')::uuid for update;
    if not found then return jsonb_build_object('code','AGENT_NOT_FOUND'); end if;
    if a.archived_at is not null then return jsonb_build_object('code','AGENT_OFFLINE'); end if;
    if p_payload->>'customer_id' is not null then
      perform 1 from public.customers where id=(p_payload->>'customer_id')::uuid for key share;
      if not found then return jsonb_build_object('code','CUSTOMER_NOT_FOUND'); end if;
    end if;
    -- Shared tool definitions can also change independently of the editor.
    -- Lock them while reading so the saved list is one consistent definition set.
    for tool in
      select t.execution_key,t.is_enabled from public.agent_tools at
      join public.tools t on t.id=at.tool_id where at.agent_id=a.id
      order by t.id for share of t
    loop
      if tool.is_enabled then
        if tool.execution_key not in ('verify_identity','evaluate_offer','create_payment_commitment','request_callback') then
          return jsonb_build_object('code','AGENT_TOOL_INVALID');
        end if;
        keys := array_append(keys,tool.execution_key);
      end if;
    end loop;
    if (keys && array['evaluate_offer','create_payment_commitment'] and not ('verify_identity'=any(keys)))
      or ('create_payment_commitment'=any(keys) and not ('evaluate_offer'=any(keys))) then
      return jsonb_build_object('code','AGENT_TOOL_PREREQUISITES');
    end if;
    snapshot := jsonb_build_object('id',a.id,'name',a.name,'instructions',a.instructions,
      'model',a.model,'voice',a.voice,'language',a.language,'tts_model',a.tts_model,
      'archived_at',a.archived_at,'enabled_tools',to_jsonb(keys),
      'customer_id',p_payload->'customer_id','call_direction',direction);
    sid := gen_random_uuid();
    insert into public.sessions(id,agent_id,room_name,source,status,agent_configuration_snapshot,created_by)
      values(sid,a.id,'browser-'||sid,
        case when direction='agent_calls_user' then 'platform_started' else 'user_started' end,
        'connecting',snapshot,p_user_id);
    if p_payload->>'customer_id' is not null then
      insert into public.collection_sessions(session_id,customer_id) values(sid,(p_payload->>'customer_id')::uuid);
    end if;
    insert into public.session_start_requests(user_id,request_key,request_payload,session_id)
      values(p_user_id,p_key,p_payload,sid) returning * into r;
  end if;
  select * into s from public.sessions where id=r.session_id;
  return jsonb_build_object('session_id',s.id,'room_name',s.room_name,'status',s.status,
    'snapshot',s.agent_configuration_snapshot,'dispatch_state',r.dispatch_state);
end $$;
revoke all on function public.session_start_reserve(uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.session_start_reserve(uuid,text,jsonb,jsonb) to service_role;
commit;
