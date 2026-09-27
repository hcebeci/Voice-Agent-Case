-- One collection account per customer for the assessment MVP.
-- Verification answers and debt details are available only to the backend.
begin;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(trim(full_name)) > 0),
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  date_of_birth date not null,
  postal_code text not null check (postal_code ~ '^[0-9]{5}$'),
  timezone text not null default 'Europe/Istanbul'
    check (timezone = 'Europe/Istanbul'),
  account_reference text not null unique,
  balance_cents integer not null check (balance_cents >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  payment_due_date date not null,
  late_interest_cents integer not null default 0
    check (late_interest_cents >= 0 and late_interest_cents <= balance_cents),
  account_status text not null default 'open'
    check (account_status in ('open', 'disputed', 'closed')),
  credit_reporting_status text not null default 'not_reported'
    check (credit_reporting_status in ('not_reported', 'pending', 'reported')),
  credit_reported_at timestamptz,
  policy_version text not null default 'collection-demo-v1',
  is_test_record boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((credit_reporting_status = 'reported') = (credit_reported_at is not null))
);

comment on table public.customers is
  'One account per customer. Backend-only; never send DOB or ZIP to the model. Test records do not represent real debts.';
comment on column public.customers.balance_cents is
  'Current total outstanding USD cents, already including late_interest_cents.';
comment on column public.customers.payment_due_date is
  'Original account due date, not the payment date agreed in a future commitment.';
comment on column public.customers.phone_e164 is
  'Null until an authorized test destination is configured. Do not dial null or invent a destination.';
comment on column public.customers.policy_version is
  'Identifies backend procedure configuration; this table does not calculate interest or submit credit reports.';

create trigger customers_set_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

alter table public.customers enable row level security;
revoke all on public.customers from public, anon, authenticated;
grant all on public.customers to service_role;

-- Explicit clock argument makes boundary tests reproducible.
create function public.collection_stage(due_date date, as_of_date date)
returns text
language sql immutable strict
set search_path = ''
as $$
  select case
    when as_of_date <= due_date then 'reminder'
    when as_of_date - due_date <= 30 then 'early'
    else 'medium'
  end;
$$;

revoke all on function public.collection_stage(date, date) from public, anon, authenticated;
grant execute on function public.collection_stage(date, date) to service_role;

-- Live stage ages naturally; the timezone controls the date at midnight.
create view public.customer_collection_context
with (security_invoker = true)
as
select
  id, full_name, phone_e164, timezone, account_reference,
  balance_cents, currency, payment_due_date, late_interest_cents,
  account_status, credit_reporting_status, credit_reported_at,
  policy_version, is_test_record,
  greatest(0, (now() at time zone timezone)::date - payment_due_date) as days_overdue,
  public.collection_stage(payment_due_date, (now() at time zone timezone)::date) as collection_stage
from public.customers;

comment on view public.customer_collection_context is
  'Backend-only account context without verification answers. Return to the agent only after session verification.';
revoke all on public.customer_collection_context from public, anon, authenticated;
grant select on public.customer_collection_context to service_role;

commit;
