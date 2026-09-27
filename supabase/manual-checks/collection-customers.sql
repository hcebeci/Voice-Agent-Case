-- Run after the customer migration and seed. Read-only assertions.
do $$
declare
  scenario text;
begin
  if public.collection_stage('2026-09-27', '2026-09-26') <> 'reminder'
     or public.collection_stage('2026-09-27', '2026-09-27') <> 'reminder'
     or public.collection_stage('2026-09-27', '2026-09-28') <> 'early'
     or public.collection_stage('2026-09-27', '2026-10-27') <> 'early'
     or public.collection_stage('2026-09-27', '2026-10-28') <> 'medium' then
    raise exception 'Stage boundary failed';
  end if;

  if (select count(*) from public.customers where account_reference in
      ('DEMO-001','DEMO-002','DEMO-003','DEMO-004','DEMO-005','DEMO-006')) <> 6 then
    raise exception 'Expected six demo customers';
  end if;
  foreach scenario in array array['reminder', 'early', 'medium'] loop
    if (select count(*) from public.customers
        where account_reference in ('DEMO-001','DEMO-002','DEMO-003','DEMO-004','DEMO-005','DEMO-006')
          and public.collection_stage(payment_due_date, '2026-09-27') = scenario) <> 2 then
      raise exception 'Expected two demo customers for %', scenario;
    end if;
  end loop;

  if exists (select 1 from public.customers where account_reference like 'DEMO-%'
             and (timezone <> 'Europe/Istanbul' or not is_test_record or phone_e164 is not null)) then
    raise exception 'Unexpected demo timezone, test flag, or phone';
  end if;
  if has_table_privilege('anon', 'public.customers', 'SELECT')
     or has_table_privilege('authenticated', 'public.customers', 'SELECT')
     or has_table_privilege('anon', 'public.customer_collection_context', 'SELECT')
     or has_table_privilege('authenticated', 'public.customer_collection_context', 'SELECT') then
    raise exception 'Customer data must remain backend-only';
  end if;
  if (('2026-09-27T21:30:00Z'::timestamptz at time zone 'Europe/Istanbul')::date) <> date '2026-09-28' then
    raise exception 'Istanbul midnight conversion failed';
  end if;
end;
$$;

select account_reference, full_name, timezone, payment_due_date,
       balance_cents, public.collection_stage(payment_due_date, '2026-09-27') as fixture_stage
from public.customers
where account_reference in ('DEMO-001','DEMO-002','DEMO-003','DEMO-004','DEMO-005','DEMO-006')
order by account_reference;
