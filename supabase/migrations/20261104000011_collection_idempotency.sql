begin;
alter table public.collection_operations add column arguments_hash text;
alter table public.follow_up_requests add column operation_id text;
create unique index follow_up_requests_operation_idx
  on public.follow_up_requests(session_id, operation_id);

-- JSONB canonicalizes object key order; no raw identity answers are persisted.
create function public.collection_arguments_hash(p_arguments jsonb)
returns text language sql immutable strict set search_path = '' as $$
  select encode(sha256(convert_to(p_arguments::text, 'UTF8')), 'hex');
$$;
revoke all on function public.collection_arguments_hash(jsonb) from public, anon, authenticated;
grant execute on function public.collection_arguments_hash(jsonb) to service_role;

drop function public.collection_snapshot(uuid,text);
create function public.collection_snapshot(
  p_session_id uuid, p_request_id text, p_tool_name text default null, p_arguments jsonb default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select jsonb_build_object('version', cs.version, 'state', cs.state,
    'customer', to_jsonb(c), 'session_status', s.status, 'now', now(),
    'result', (select case when o.tool_name = p_tool_name
          and o.arguments_hash = public.collection_arguments_hash(p_arguments) then o.result
        else jsonb_build_object('tool_name',p_tool_name,'status','rejected',
          'code',case when o.arguments_hash is null then 'IDEMPOTENCY_LEGACY_RECEIPT' else 'IDEMPOTENCY_KEY_REUSED' end,
          'verified_user',coalesce((cs.state->>'verified')::boolean,false),'data','{}'::jsonb) end
      from public.collection_operations o
      where o.session_id = cs.session_id and o.request_id = p_request_id))
  from public.collection_sessions cs
  join public.sessions s on s.id = cs.session_id
  left join public.customers c on c.id = cs.customer_id
  where cs.session_id = p_session_id;
$$;

drop function public.collection_commit(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb);
create function public.collection_commit(
  p_session_id uuid, p_request_id text, p_version bigint, p_state jsonb,
  p_result jsonb, p_effect jsonb, p_arguments jsonb, p_user_turn_id text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  cs public.collection_sessions;
  previous public.collection_operations;
  saved_callback public.follow_up_requests;
  session_status text;
  tool text := p_result->>'tool_name';
  fingerprint text := public.collection_arguments_hash(p_arguments);
  callback_key text;
begin
  select status into session_status from public.sessions where id = p_session_id for update;
  select * into cs from public.collection_sessions where session_id = p_session_id for update;
  if not found then raise exception 'COLLECTION_SESSION_MISSING'; end if;
  select * into previous from public.collection_operations
    where session_id = p_session_id and request_id = p_request_id;
  if found then
    if previous.tool_name = tool and previous.arguments_hash = fingerprint then
      return jsonb_build_object('result',previous.result,'state',cs.state);
    end if;
    return jsonb_build_object('state',cs.state,'result',jsonb_build_object(
      'tool_name',tool,'status','rejected','code',case when previous.arguments_hash is null
        then 'IDEMPOTENCY_LEGACY_RECEIPT' else 'IDEMPOTENCY_KEY_REUSED' end,
      'verified_user',coalesce((cs.state->>'verified')::boolean,false),'data','{}'::jsonb));
  end if;
  if cs.version <> p_version then return jsonb_build_object('conflict', true); end if;
  perform 1 from public.customers where id = cs.customer_id
    and updated_at = (p_state->>'customer_updated_at')::timestamptz for share;
  if not found then return jsonb_build_object('conflict', true); end if;
  if session_status not in ('connecting','active') then
    p_result := jsonb_build_object('tool_name',tool,'status','rejected','code','SESSION_NOT_ACTIVE',
      'verified_user',coalesce((cs.state->>'verified')::boolean,false),'data','{}'::jsonb);
    p_state := cs.state;
    p_effect := null;
  end if;
  if p_effect->>'kind' = 'commitment' then
    insert into public.payment_commitments(id,session_id,customer_id,proposal_id,amount_cents,currency,payment_date,confirmation_turn_id,policy_version)
    values ((p_effect->>'commitment_id')::uuid,p_session_id,cs.customer_id,(p_effect->>'proposal_id')::uuid,
      (p_effect->>'amount_cents')::integer,p_effect->>'currency',(p_effect->>'payment_date')::date,
      p_effect->>'confirmation_turn_id',p_effect->>'policy_version');
  elsif p_effect->>'kind' = 'callback' then
    if nullif(p_user_turn_id,'') is null then raise exception 'USER_MESSAGE_REQUIRED'; end if;
    callback_key := p_user_turn_id || ':' || to_char(
      (p_effect->>'callback_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00';
    if p_effect->>'operation_id' is distinct from callback_key then raise exception 'CALLBACK_IDENTITY_MISMATCH'; end if;
    insert into public.follow_up_requests(id,session_id,customer_id,kind,callback_at,operation_id)
      values ((p_effect->>'request_id')::uuid,p_session_id,cs.customer_id,'callback',
        (p_effect->>'callback_at')::timestamptz,callback_key)
      on conflict (session_id,operation_id) do nothing;
    select * into saved_callback from public.follow_up_requests
      where session_id=p_session_id and operation_id=callback_key;
    -- The original receipt is authoritative even if a stale worker generated a new UUID.
    if saved_callback.id <> (p_effect->>'request_id')::uuid then
      p_result := jsonb_set(p_result,'{data}',coalesce(cs.state->'callbacks'->callback_key,
        jsonb_build_object('request_id',saved_callback.id,'callback_at',saved_callback.callback_at,
          'timezone',(select timezone from public.customers where id=cs.customer_id),'status',saved_callback.status)));
      p_state := jsonb_set(p_state,'{callbacks}',coalesce(p_state->'callbacks','{}'::jsonb)
        || jsonb_build_object(callback_key,p_result->'data'));
    end if;
  end if;
  update public.collection_sessions set state=p_state,version=version+1 where session_id=p_session_id;
  insert into public.collection_operations(session_id,request_id,tool_name,result,arguments_hash)
    values(p_session_id,p_request_id,tool,p_result,fingerprint);
  insert into public.session_events(session_id,event_type,payload)
    values(p_session_id,'collection.tool_result',jsonb_build_object('request_id',p_request_id,
      'arguments',case when tool='verify_identity' then '{"redacted":true}'::jsonb else p_arguments end,
      'result',p_result,'policy_version',p_state->'policy'->>'version'));
  return jsonb_build_object('result',p_result,'state',p_state);
end $$;
revoke all on function public.collection_snapshot(uuid,text,text,jsonb),
  public.collection_commit(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.collection_snapshot(uuid,text,text,jsonb),
  public.collection_commit(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb,text) to service_role;
commit;
