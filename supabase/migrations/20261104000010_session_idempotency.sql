-- A browser call attempt has a durable identity scoped to its authenticated user.
-- Only service_role may use these primitives; the Edge Function supplies verified user id.
begin;
create table public.session_start_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_key text not null check (char_length(request_key) between 8 and 200),
  request_payload jsonb not null,
  session_id uuid not null unique references public.sessions(id) on delete restrict,
  dispatch_state text not null default 'reserved' check (dispatch_state in ('reserved','dispatching','ready')),
  created_at timestamptz not null default now(),
  primary key (user_id, request_key)
);
alter table public.session_start_requests enable row level security;
revoke all on public.session_start_requests from public, anon, authenticated;
grant all on public.session_start_requests to service_role;

create function public.session_start_reserve(p_user_id uuid, p_key text, p_payload jsonb, p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.session_start_requests; s public.sessions; sid uuid;
begin
  -- Serialize even before the receipt exists. Hash collisions only serialize unrelated calls.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_key, 0));
  select * into r from session_start_requests where user_id=p_user_id and request_key=p_key;
  if found then
    if r.request_payload <> p_payload then return jsonb_build_object('code','IDEMPOTENCY_KEY_REUSED'); end if;
  else
    sid := gen_random_uuid();
    insert into sessions(id,agent_id,room_name,source,status,agent_configuration_snapshot,created_by)
      values(sid,(p_payload->>'agent_id')::uuid,'browser-'||sid,
        case when p_payload->>'call_direction'='agent_calls_user' then 'platform_started' else 'user_started' end,
        'connecting',p_snapshot,p_user_id);
    if p_payload->>'customer_id' is not null then
      insert into collection_sessions(session_id,customer_id) values(sid,(p_payload->>'customer_id')::uuid);
    end if;
    insert into session_start_requests(user_id,request_key,request_payload,session_id)
      values(p_user_id,p_key,p_payload,sid) returning * into r;
  end if;
  select * into s from sessions where id=r.session_id;
  return jsonb_build_object('session_id',s.id,'room_name',s.room_name,'status',s.status,
    'snapshot',s.agent_configuration_snapshot,'dispatch_state',r.dispatch_state);
end $$;

-- No lease expiry: after issuing a remote write its absence cannot be inferred from a timeout.
create function public.session_start_dispatch(p_user_id uuid,p_key text,p_ready boolean default false)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_ready then
    update session_start_requests set dispatch_state='ready'
      where user_id=p_user_id and request_key=p_key and dispatch_state in ('dispatching','ready');
  else
    update session_start_requests set dispatch_state='dispatching'
      where user_id=p_user_id and request_key=p_key and dispatch_state='reserved';
  end if;
  return found;
end $$;
revoke all on function public.session_start_reserve(uuid,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.session_start_dispatch(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.session_start_reserve(uuid,text,jsonb,jsonb) to service_role;
grant execute on function public.session_start_dispatch(uuid,text,boolean) to service_role;
commit;
