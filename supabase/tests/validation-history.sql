\set ON_ERROR_STOP on
set role service_role;
do $$
declare snapshot jsonb;
begin
  foreach snapshot in array array['{}'::jsonb,'{"is_test_record":false}'::jsonb,'{"is_test_record":null}'::jsonb] loop
    begin
      insert into public.test_runs(id,scenario_id,scenario_name,execution_type,status,configuration_version,policy_version,customer_snapshot,expected_outcome,actual_outcome,report_hash)
        values('50000000-0000-0000-0000-000000000001','sql','Synthetic boundary','integration','passed','v1','v1',snapshot,'{}','{}','test');
      raise exception 'Non-synthetic report inserted: %',snapshot;
    exception when check_violation then null; end;
  end loop;
  insert into public.test_runs(id,scenario_id,scenario_name,execution_type,status,configuration_version,policy_version,customer_snapshot,expected_outcome,actual_outcome,report_hash)
    values('50000000-0000-0000-0000-000000000001','sql','Synthetic boundary','integration','passed','v1','v1','{"is_test_record":true,"date_of_birth":"1990-01-01","postal_code":"00000"}','{}','{}','test');
  if has_table_privilege(current_user,'public.test_runs','UPDATE,DELETE,TRUNCATE') then raise exception 'Service can rewrite history'; end if;
  begin update public.test_runs set status='failed'; raise exception 'Service update succeeded'; exception when insufficient_privilege then null; end;
  begin delete from public.test_runs; raise exception 'Service delete succeeded'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
do $$
begin
  if not has_table_privilege(current_user,'public.test_runs','SELECT') then raise exception 'Browser cannot read history'; end if;
  if has_table_privilege(current_user,'public.test_runs','INSERT,UPDATE,DELETE,TRUNCATE') then raise exception 'Browser can rewrite history'; end if;
  begin insert into public.test_runs select * from public.test_runs; raise exception 'Browser insert succeeded'; exception when insufficient_privilege then null; end;
  begin update public.test_runs set status='failed'; raise exception 'Browser update succeeded'; exception when insufficient_privilege then null; end;
  begin delete from public.test_runs; raise exception 'Browser delete succeeded'; exception when insufficient_privilege then null; end;
  if (select customer_snapshot->>'postal_code' from public.test_runs where id='50000000-0000-0000-0000-000000000001') <> '00000' then raise exception 'Synthetic evidence was altered'; end if;
end $$;
reset role;
