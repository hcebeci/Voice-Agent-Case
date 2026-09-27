import { withSupabase } from "npm:@supabase/server"

type AgentUpdate = {
  name?: string
  description?: string
  instructions?: string
  model?: string
  voice?: string | null
  language?: string
  tts_model?: string
  archived_at?: string | null
}

type AgentCreate = {
  name: string
  description?: string
  instructions?: string
  model: string
  voice?: string | null
  language?: string
  tts_model?: string
}

const editableAgentFields = [
  "name",
  "description",
  "instructions",
  "model",
  "voice",
  "language",
  "tts_model",
  "archived_at",
] as const

const creatableAgentFields = [
  "name",
  "description",
  "instructions",
  "model",
  "voice",
  "language",
  "tts_model",
] as const

const supportedAgentLanguages = new Set(["en", "tr"])
const supportedTtsModels = new Set(["cartesia/sonic-3", "inworld/inworld-tts-2"])

/** Return a consistent JSON error response for validation and database failures. */
function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

/** Keep client input limited to fields the agent editor is allowed to change. */
function pickEditableAgentFields(input: Record<string, unknown>): AgentUpdate {
  return Object.fromEntries(
    editableAgentFields
      .filter((fieldName) => fieldName in input)
      .map((fieldName) => [fieldName, input[fieldName]]),
  ) as AgentUpdate
}

/** Select only fields that are valid when a new saved agent is created. */
function pickCreatableAgentFields(input: Record<string, unknown>): AgentUpdate {
  return Object.fromEntries(
    creatableAgentFields
      .filter((fieldName) => fieldName in input)
      .map((fieldName) => [fieldName, input[fieldName]]),
  ) as AgentUpdate
}

/** Reject missing or invalid required values before writing to Supabase. */
function validateAgentFields(input: AgentUpdate): string | null {
  if ("name" in input && (typeof input.name !== "string" || !input.name.trim())) {
    return "Agent name is required."
  }
  if ("model" in input && (typeof input.model !== "string" || !input.model.trim())) {
    return "Agent model is required."
  }
  if ("language" in input && (typeof input.language !== "string" || !supportedAgentLanguages.has(input.language))) {
    return "Agent language must be en or tr."
  }
  if ("tts_model" in input && (typeof input.tts_model !== "string" || !supportedTtsModels.has(input.tts_model))) {
    return "Agent TTS model is not supported."
  }
  if (
    "archived_at" in input &&
    input.archived_at !== null &&
    typeof input.archived_at !== "string"
  ) {
    return "archived_at must be an ISO timestamp or null."
  }
  return null
}

/** Enforce the required fields for a new agent before the insert request. */
function validateNewAgentFields(input: AgentUpdate): string | null {
  if (typeof input.name !== "string" || !input.name.trim()) {
    return "Agent name is required."
  }
  if (typeof input.model !== "string" || !input.model.trim()) {
    return "Agent model is required."
  }
  return validateAgentFields(input)
}

/** Add the runtime badge derived from archived state and active sessions. */
async function addRuntimeStatus(supabaseClient: any, agents: any[]) {
  const { data: activeSessions, error } = await supabaseClient
    .from("sessions")
    .select("agent_id")
    .in("status", ["connecting", "active"])

  if (error) throw new Error(error.message)

  const activeSessionCounts = new Map<string, number>()
  for (const session of activeSessions ?? []) {
    activeSessionCounts.set(
      session.agent_id,
      (activeSessionCounts.get(session.agent_id) ?? 0) + 1,
    )
  }

  return agents.map((agent) => {
    const activeSessionCount = activeSessionCounts.get(agent.id) ?? 0
    const runtimeStatus = agent.archived_at
      ? "offline"
      : activeSessionCount > 0
        ? "active"
        : "sleeping"

    return {
      ...agent,
      active_session_count: activeSessionCount,
      runtime_status: runtimeStatus,
    }
  })
}

/** Handle agent list, create, update, and archive requests for authenticated users. */
export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    const requestUrl = new URL(request.url)
    const agentId = requestUrl.searchParams.get("id")
    const shouldIncludeHistory = requestUrl.searchParams.get("include") === "history"

    if (request.method === "GET") {
      if (agentId) {
        const { data: agent, error: agentError } = await context.supabase
          .from("agents")
          .select("*")
          .eq("id", agentId)
          .single()

        if (agentError) return errorResponse(agentError.message, 404)

        let agentsWithRuntimeStatus: any[]
        try {
          agentsWithRuntimeStatus = await addRuntimeStatus(context.supabase, [agent])
        } catch (runtimeError) {
          return errorResponse((runtimeError as Error).message, 500)
        }

        const agentWithRuntimeStatus = agentsWithRuntimeStatus[0]

        if (shouldIncludeHistory) {
          const { data: history, error: historyError } = await context.supabase
            .from("agent_change_events")
            .select("*")
            .eq("agent_id", agentId)
            .order("occurred_at", { ascending: false })

          if (historyError) return errorResponse(historyError.message, 500)
          return Response.json({ agent: agentWithRuntimeStatus, history })
        }

        return Response.json({ agent: agentWithRuntimeStatus })
      }

      const { data, error } = await context.supabase
        .from("agents")
        .select("*")
        .order("created_at", { ascending: false })

      if (error) return errorResponse(error.message, 500)
      try {
        return Response.json({
          agents: await addRuntimeStatus(context.supabase, data ?? []),
        })
      } catch (runtimeError) {
        return errorResponse((runtimeError as Error).message, 500)
      }
    }

    if (request.method === "POST") {
      let requestBody: AgentCreate
      try {
        requestBody = await request.json()
      } catch {
        return errorResponse("Request body must be valid JSON.", 400)
      }

      const agentFields = pickCreatableAgentFields(requestBody as Record<string, unknown>)
      const validationError = validateNewAgentFields(agentFields)
      if (validationError) return errorResponse(validationError, 400)

      const { data, error } = await context.supabase
        .from("agents")
        .insert({
          ...agentFields,
          created_by: context.userClaims.id,
        })
        .select()
        .single()

      if (error) return errorResponse(error.message, 500)
      return Response.json({ agent: data }, { status: 201 })
    }

    if (request.method === "PATCH") {
      if (!agentId) return errorResponse("An agent id is required.", 400)

      let requestBody: Record<string, unknown>
      try {
        requestBody = await request.json()
      } catch {
        return errorResponse("Request body must be valid JSON.", 400)
      }

      const agentFields = pickEditableAgentFields(requestBody)
      const validationError = validateAgentFields(agentFields)
      if (validationError) return errorResponse(validationError, 400)
      if (Object.keys(agentFields).length === 0) {
        return errorResponse("At least one agent field is required.", 400)
      }

      const { data, error } = await context.supabase
        .from("agents")
        .update(agentFields)
        .eq("id", agentId)
        .select()
        .single()

      if (error) return errorResponse(error.message, 500)
      return Response.json({ agent: data })
    }

    if (request.method === "DELETE") {
      if (!agentId) return errorResponse("An agent id is required.", 400)

      const { data, error } = await context.supabase
        .from("agents")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", agentId)
        .is("archived_at", null)
        .select()
        .single()

      if (error) return errorResponse(error.message, 500)
      return Response.json({ agent: data })
    }

    return errorResponse("Method not allowed.", 405)
  }),
}
