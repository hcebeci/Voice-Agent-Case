import { withSupabase } from "npm:@supabase/server"
import { pickToolFields, validateAssignments, validateToolFields } from "./validation.mjs"

type ToolRecord = Record<string, unknown>

/** Return a consistent JSON error response for tool-library requests. */
function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

/** Read the shared tool library, optionally marking assignments for one agent. */
async function loadTools(supabaseClient: any, agentId: string | null) {
  const { data: tools, error: toolsError } = await supabaseClient
    .from("tools")
    .select("id, name, description, execution_key, input_schema, is_enabled, created_at, updated_at")
    .order("name", { ascending: true })
  if (toolsError) throw new Error(toolsError.message)

  if (!agentId) return tools ?? []
  const { data: assignments, error: assignmentsError } = await supabaseClient
    .from("agent_tools")
    .select("tool_id, configuration")
    .eq("agent_id", agentId)
  if (assignmentsError) throw new Error(assignmentsError.message)
  const assignmentByToolId = new Map((assignments ?? []).map((assignment: ToolRecord) => [assignment.tool_id, assignment]))
  return (tools ?? []).map((tool: ToolRecord) => ({
    ...tool,
    assigned: assignmentByToolId.has(tool.id),
    configuration: assignmentByToolId.get(tool.id)?.configuration ?? {},
  }))
}

/** Replace all tools assigned to one agent with the submitted set. */
async function replaceAgentAssignments(supabaseClient: any, agentId: string, assignments: ToolRecord[]) {
  const { data: agent, error: agentError } = await supabaseClient
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .maybeSingle()
  if (agentError) throw new Error(agentError.message)
  if (!agent) return errorResponse("Agent not found.", 404)

  const toolIds = assignments.map((assignment) => assignment.tool_id as string)
  if (toolIds.length) {
    const { data: enabledTools, error: toolsError } = await supabaseClient
      .from("tools")
      .select("id")
      .in("id", toolIds)
      .eq("is_enabled", true)
    if (toolsError) throw new Error(toolsError.message)
    if ((enabledTools ?? []).length !== toolIds.length) return errorResponse("Every assigned tool must exist and be enabled.", 400)
  }

  const { error: deleteError } = await supabaseClient.from("agent_tools").delete().eq("agent_id", agentId)
  if (deleteError) throw new Error(deleteError.message)
  if (assignments.length) {
    const { error: insertError } = await supabaseClient.from("agent_tools").insert(
      assignments.map((assignment) => ({
        agent_id: agentId,
        tool_id: assignment.tool_id,
        configuration: assignment.configuration ?? {},
      })),
    )
    if (insertError) throw new Error(insertError.message)
  }
  return Response.json({ tools: await loadTools(supabaseClient, agentId) })
}

/** Handle shared tool definitions and agent assignments for the single workspace. */
export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    const requestUrl = new URL(request.url)
    const toolId = requestUrl.searchParams.get("id")
    const agentId = requestUrl.searchParams.get("agent_id")

    if (request.method === "GET") {
      try {
        return Response.json({ tools: await loadTools(context.supabase, agentId) })
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : "Could not load tools.", 500)
      }
    }

    if (request.method === "POST") {
      let requestBody: ToolRecord
      try {
        requestBody = await request.json()
      } catch {
        return errorResponse("Request body must be valid JSON.", 400)
      }
      const fields = pickToolFields(requestBody, true)
      const validationError = validateToolFields(fields, { requireName: true })
      if (validationError) return errorResponse(validationError, 400)
      if (!fields.execution_key) return errorResponse("Execution key is required.", 400)
      const { data, error } = await context.supabase
        .from("tools")
        .insert({ ...fields, description: fields.description ?? "", input_schema: fields.input_schema ?? {} })
        .select()
        .single()
      if (error) return errorResponse(error.message, 400)
      return Response.json({ tool: data }, { status: 201 })
    }

    if (request.method === "PATCH") {
      if (!toolId) return errorResponse("A tool id is required.", 400)
      let requestBody: ToolRecord
      try {
        requestBody = await request.json()
      } catch {
        return errorResponse("Request body must be valid JSON.", 400)
      }
      const fields = pickToolFields(requestBody, true)
      const validationError = validateToolFields(fields)
      if (validationError) return errorResponse(validationError, 400)
      if (!Object.keys(fields).length) return errorResponse("At least one tool field is required.", 400)
      const { data, error } = await context.supabase.from("tools").update(fields).eq("id", toolId).select().single()
      if (error) return errorResponse(error.message, 400)
      return Response.json({ tool: data })
    }

    if (request.method === "DELETE") {
      if (!toolId) return errorResponse("A tool id is required.", 400)
      const { data, error } = await context.supabase.from("tools").update({ is_enabled: false }).eq("id", toolId).select().single()
      if (error) return errorResponse(error.message, 400)
      return Response.json({ tool: data })
    }

    if (request.method === "PUT") {
      if (!agentId) return errorResponse("An agent id is required.", 400)
      let requestBody: ToolRecord
      try {
        requestBody = await request.json()
      } catch {
        return errorResponse("Request body must be valid JSON.", 400)
      }
      const validationError = validateAssignments(requestBody.assignments)
      if (validationError) return errorResponse(validationError, 400)
      try {
        return await replaceAgentAssignments(context.supabase, agentId, requestBody.assignments as ToolRecord[])
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : "Could not assign tools.", 500)
      }
    }

    return errorResponse("Method not allowed.", 405)
  }),
}
