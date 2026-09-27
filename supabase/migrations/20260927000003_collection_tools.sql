-- Worker-only state and atomic effects; browser users cannot verify themselves.
begin;
create table public.collection_sessions (
  session_id uuid primary key references public.sessions(id),
  customer_id uuid not null references public.customers(id),
  version bigint not null default 0,
  state jsonb not null default '{"verified":false,"attempts":0,"policy":{"version":"collection-demo-v1","minimum_payment_cents":80000,"maximum_extension_days":14,"maximum_verification_attempts":3}}'
);
create table public.collection_operations (
  session_id uuid not null references public.collection_sessions(session_id),
  request_id text not null,
  tool_name text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, request_id)
);
create table public.payment_commitments (
  id uuid primary key,
  session_id uuid not null references public.collection_sessions(session_id),
  customer_id uuid not null references public.customers(id),
  proposal_id uuid not null unique,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null,
  payment_date date not null,
  confirmation_turn_id text not null,
  policy_version text not null,
  created_at timestamptz not null default now()
);
create table public.follow_up_requests (
  id uuid primary key,
  session_id uuid not null references public.collection_sessions(session_id),
  customer_id uuid not null references public.customers(id),
  kind text not null check (kind = 'callback'),
  callback_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);

alter table public.collection_sessions enable row level security;
alter table public.collection_operations enable row level security;
alter table public.payment_commitments enable row level security;
alter table public.follow_up_requests enable row level security;
revoke all on public.collection_sessions, public.collection_operations, public.payment_commitments, public.follow_up_requests from public, anon, authenticated;
grant all on public.collection_sessions, public.collection_operations, public.payment_commitments, public.follow_up_requests to service_role;

-- Fetch a trusted clock and customer snapshot without exposing it to the browser.
create function public.collection_snapshot(p_session_id uuid, p_request_id text)
returns jsonb language sql security invoker set search_path = '' as $$
  select jsonb_build_object('version', cs.version, 'state', cs.state,
    'customer', to_jsonb(c), 'session_status', s.status, 'now', now(),
    'result', (select o.result from public.collection_operations o
               where o.session_id = cs.session_id and o.request_id = p_request_id))
  from public.collection_sessions cs
  join public.sessions s on s.id = cs.session_id
  left join public.customers c on c.id = cs.customer_id
  where cs.session_id = p_session_id;
$$;

-- Optimistic concurrency checks serialize independent workers, not just local tasks.
-- The state transition, receipt, business record and audit event commit together.
create function public.collection_commit(
  p_session_id uuid, p_request_id text, p_version bigint, p_state jsonb,
  p_result jsonb, p_effect jsonb, p_arguments jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  cs public.collection_sessions;
  previous jsonb;
  session_status text;
  tool text := p_result->>'tool_name';
begin
  select status into session_status from public.sessions where id = p_session_id for update;
  select * into cs from public.collection_sessions where session_id = p_session_id for update;
  if not found then raise exception 'COLLECTION_SESSION_MISSING'; end if;
  select result into previous from public.collection_operations
    where session_id = p_session_id and request_id = p_request_id;
  if found then return jsonb_build_object('result', previous); end if;
  if cs.version <> p_version then return jsonb_build_object('conflict', true); end if;
  -- Read-lock account during the commit; reject stale customer snapshots via updated_at.
  perform 1 from public.customers where id = cs.customer_id
    and updated_at = (p_state->>'customer_updated_at')::timestamptz for share;
  if not found then return jsonb_build_object('conflict', true); end if;
  if session_status not in ('connecting', 'active') then
    p_result := jsonb_build_object('tool_name', tool, 'status', 'rejected',
      'code', 'SESSION_NOT_ACTIVE', 'verified_user', coalesce((cs.state->>'verified')::boolean, false), 'data', '{}'::jsonb);
    p_state := cs.state;
    p_effect := null;
  end if;
  if p_effect->>'kind' = 'commitment' then
    insert into public.payment_commitments(id,session_id,customer_id,proposal_id,amount_cents,currency,payment_date,confirmation_turn_id,policy_version)
    values ((p_effect->>'commitment_id')::uuid,p_session_id,cs.customer_id,(p_effect->>'proposal_id')::uuid,
      (p_effect->>'amount_cents')::integer,p_effect->>'currency',(p_effect->>'payment_date')::date,
      p_effect->>'confirmation_turn_id',p_effect->>'policy_version');
  elsif p_effect->>'kind' = 'callback' then
    insert into public.follow_up_requests(id,session_id,customer_id,kind,callback_at)
    values ((p_effect->>'request_id')::uuid,p_session_id,cs.customer_id,'callback',(p_effect->>'callback_at')::timestamptz);
  end if;
  update public.collection_sessions set state = p_state, version = version + 1 where session_id = p_session_id;
  insert into public.collection_operations(session_id,request_id,tool_name,result)
    values (p_session_id,p_request_id,tool,p_result);
  insert into public.session_events(session_id,event_type,payload)
    values (p_session_id,'collection.tool_result',jsonb_build_object('request_id',p_request_id,
      'arguments',case when tool = 'verify_identity' then '{"redacted":true}'::jsonb else p_arguments end,
      'result',p_result,'policy_version',p_state->'policy'->>'version'));
  return jsonb_build_object('result',p_result);
end;
$$;
revoke all on function public.collection_snapshot(uuid,text), public.collection_commit(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.collection_snapshot(uuid,text), public.collection_commit(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb) to service_role;

insert into public.tools(name,description,execution_key,input_schema) values
('verify_identity','Verify DOB and postal code before disclosing account details.','verify_identity',
 '{"type":"object","properties":{"date_of_birth":{"type":"string","format":"date"},"postal_code":{"type":"string","pattern":"^[0-9]{5}$"}},"required":["date_of_birth","postal_code"],"additionalProperties":false}'),
('evaluate_offer','Validate a proposed payment amount and date; does not save a commitment.','evaluate_offer',
 '{"type":"object","properties":{"amount_cents":{"type":"integer","minimum":1},"payment_date":{"type":"string","format":"date"}},"required":["amount_cents","payment_date"],"additionalProperties":false}'),
('create_payment_commitment','Save the current presented proposal only after a later customer confirmation.','create_payment_commitment',
 '{"type":"object","properties":{"proposal_id":{"type":"string"}},"required":["proposal_id"],"additionalProperties":false}'),
('request_callback','Save a future callback request to the registered number.','request_callback',
 '{"type":"object","properties":{"callback_at":{"type":"string","format":"date-time"}},"required":["callback_at"],"additionalProperties":false}')
on conflict (name) do nothing;
commit;
