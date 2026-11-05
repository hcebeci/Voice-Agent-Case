begin;
-- Extend future audit events without rewriting any existing history.
create or replace function public.record_agent_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  tracked_fields text[] := array['name','description','instructions','model','voice','language','tts_model','archived_at'];
  changed_fields text[] := '{}';
  previous_values jsonb := '{}';
  new_values jsonb := '{}';
  field_name text;
  change_kind text;
begin
  if tg_op='INSERT' then
    change_kind := 'created';
  elsif old.archived_at is null and new.archived_at is not null then
    change_kind := 'archived';
  elsif old.archived_at is not null and new.archived_at is null then
    change_kind := 'restored';
  else
    change_kind := 'updated';
  end if;
  foreach field_name in array tracked_fields loop
    if tg_op='INSERT' or (to_jsonb(old)->field_name) is distinct from (to_jsonb(new)->field_name) then
      changed_fields := array_append(changed_fields,field_name);
      new_values := new_values || jsonb_build_object(field_name,to_jsonb(new)->field_name);
      if tg_op <> 'INSERT' then
        previous_values := previous_values || jsonb_build_object(field_name,to_jsonb(old)->field_name);
      end if;
    end if;
  end loop;
  if cardinality(changed_fields)>0 then
    insert into public.agent_change_events(agent_id,changed_by,change_type,changed_fields,previous_values,new_values)
      values(new.id,auth.uid(),change_kind,changed_fields,previous_values,new_values);
  end if;
  return new;
end $$;
commit;
