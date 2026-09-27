-- Shared tool definitions and agent assignments
select id, name, execution_key, is_enabled, created_at, updated_at
from public.tools
order by name;

select
  a.name as agent_name,
  t.name as tool_name,
  t.execution_key,
  t.is_enabled,
  at.configuration,
  at.created_at as assigned_at
from public.agent_tools at
join public.agents a on a.id = at.agent_id
join public.tools t on t.id = at.tool_id
order by a.name, t.name;

-- An assigned tool should always be enabled before runtime execution is added.
select a.name as agent_name, t.name as disabled_assigned_tool
from public.agent_tools at
join public.agents a on a.id = at.agent_id
join public.tools t on t.id = at.tool_id
where t.is_enabled = false;

-- Execution keys are the stable backend dispatch names and must be unique.
select execution_key, count(*) as definition_count
from public.tools
group by execution_key
having count(*) > 1;
