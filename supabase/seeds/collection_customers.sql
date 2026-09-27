-- Fictional assessment data. Names supplied by the user; all other values invented.
-- Fixed scenario clock: 2026-09-27 in Europe/Istanbul.
-- Deliberately no DELETE, TRUNCATE, or conflict UPDATE: preserve test history.
begin;

insert into public.customers (
  id, full_name, phone_e164, date_of_birth, postal_code, timezone,
  account_reference, balance_cents, currency, payment_due_date,
  late_interest_cents, account_status, credit_reporting_status,
  credit_reported_at, policy_version, is_test_record
)
values
  ('c011ec70-0000-4000-8000-000000000001', 'Alper Araras', null,
   '1988-04-12', '34000', 'Europe/Istanbul', 'DEMO-001', 200000, 'USD',
   '2026-09-15', 2500, 'open', 'not_reported', null, 'collection-demo-v1', true),
  ('c011ec70-0000-4000-8000-000000000002', 'Alptuğ Tekin', null,
   '1992-11-03', '06000', 'Europe/Istanbul', 'DEMO-002', 120000, 'USD',
   '2026-10-04', 0, 'open', 'not_reported', null, 'collection-demo-v1', true),
  ('c011ec70-0000-4000-8000-000000000003', 'Hasancan cebeci', null,
   '1990-06-18', '35000', 'Europe/Istanbul', 'DEMO-003', 150000, 'USD',
   '2026-09-02', 1800, 'open', 'not_reported', null, 'collection-demo-v1', true),
  ('c011ec70-0000-4000-8000-000000000004', 'Hasancan Çelebi', null,
   '1985-02-09', '16000', 'Europe/Istanbul', 'DEMO-004', 300000, 'USD',
   '2026-08-13', 9000, 'open', 'reported', '2026-09-13T10:00:00+03:00',
   'collection-demo-v1', true),
  ('c011ec70-0000-4000-8000-000000000005', 'Ömer Can Sökmen', null,
   '1995-09-24', '07000', 'Europe/Istanbul', 'DEMO-005', 60000, 'USD',
   '2026-09-30', 0, 'open', 'not_reported', null, 'collection-demo-v1', true),
  ('c011ec70-0000-4000-8000-000000000006', 'Ömer Can cebeci', null,
   '1987-12-05', '26000', 'Europe/Istanbul', 'DEMO-006', 250000, 'USD',
   '2026-07-29', 10000, 'open', 'reported', '2026-08-29T10:00:00+03:00',
   'collection-demo-v1', true)
on conflict (account_reference) do nothing;

commit;
