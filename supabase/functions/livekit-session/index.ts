import { withSupabase } from "npm:@supabase/server"
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "npm:livekit-server-sdk"

type SessionRequest = {
  agent_id?: unknown
  source?: unknown
  customer_id?: unknown
}

const allowedStatuses = new Set(["connecting", "active", "completed", "failed", "cancelled"])

/** Return a JSON error that is safe for the browser to display. */
function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

/** Convert the browser-facing WebSocket URL into the HTTPS URL used by LiveKit APIs. */
function livekitApiHost(livekitUrl: string): string {
  return livekitUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:")
}

/** Parse the create-session request without trusting arbitrary client fields. */
async function parseSessionRequest(request: Request): Promise<SessionRequest> {
  try {
    return await request.json()
  } catch {
    throw new Error("Request body must be valid JSON.")
  }
}

/** Create a browser token and explicitly dispatch the configured agent into its room. */
async function createBrowserSession(request: Request, context: any): Promise<Response> {
  const requestBody = await parseSessionRequest(request)
  const agentId = typeof requestBody.agent_id === "string" ? requestBody.agent_id : ""
  const source = requestBody.source ?? "user_started"
  const customerId = requestBody.customer_id
  if (customerId !== undefined && (typeof customerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId))) {
    return errorResponse("A valid customer id is required.", 400)
  }
  if (customerId) {
    const { data: customer, error } = await context.supabaseAdmin.from("customers").select("id").eq("id", customerId).maybeSingle()
    if (error || !customer) return errorResponse("Customer not found.", 404)
  }

  if (!agentId) return errorResponse("An agent id is required.", 400)
  if (source !== "user_started") return errorResponse("Only user_started sessions are supported in the browser MVP.", 400)

  const { data: agent, error: agentError } = await context.supabase
    .from("agents")
    .select("id, name, instructions, model, voice, language, tts_model, archived_at")
    .eq("id", agentId)
    .single()

  if (agentError || !agent) return errorResponse("The selected agent could not be found.", 404)
  if (agent.archived_at) return errorResponse("This agent is offline. Activate it before starting a session.", 409)

  const livekitUrl = Deno.env.get("LIVEKIT_URL")
  const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY")
  const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET")
  if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
    return errorResponse("LiveKit is not configured on the session function.", 503)
  }

  const sessionId = crypto.randomUUID()
  const roomName = `browser-${sessionId}`
  const participantIdentity = `user-${context.userClaims.sub}-${sessionId.slice(0, 8)}`
  const configurationSnapshot = {
    id: agent.id,
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    voice: agent.voice,
    language: agent.language,
    tts_model: agent.tts_model,
  }

  const { error: sessionError } = await context.supabase.from("sessions").insert({
    id: sessionId,
    agent_id: agent.id,
    room_name: roomName,
    source: "user_started",
    status: "connecting",
    agent_configuration_snapshot: configurationSnapshot,
    created_by: context.userClaims.sub,
  })

  if (sessionError) return errorResponse(sessionError.message, 500)

  try {
    if (customerId) {
      const { error } = await context.supabaseAdmin.from("collection_sessions").insert({ session_id: sessionId, customer_id: customerId })
      if (error) throw new Error("Could not bind customer to session.")
    }
    const participantToken = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: participantIdentity,
      name: "User",
      ttl: "2h",
    })
    participantToken.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    })

    const apiHost = livekitApiHost(livekitUrl)
    const roomService = new RoomServiceClient(apiHost, livekitApiKey, livekitApiSecret)

    // Keep abandoned browser rooms short-lived so room_finished reaches the
    // webhook promptly after the browser closes. These values are deliberately
    // explicit instead of relying on LiveKit's longer defaults.
    await roomService.createRoom({
      name: roomName,
      emptyTimeout: 30,
      departureTimeout: 20,
      maxParticipants: 4,
    })

    const dispatchClient = new AgentDispatchClient(apiHost, livekitApiKey, livekitApiSecret)
    await dispatchClient.createDispatch(roomName, "Voice-Agent-Case", {
      metadata: JSON.stringify({
        collection_mode: Boolean(customerId),
        session_id: sessionId,
        agent_id: agent.id,
        agent_name: agent.name,
        instructions: agent.instructions,
        model: agent.model,
        voice: agent.voice,
        language: agent.language,
        tts_model: agent.tts_model,
        source: "user_started",
      }),
    })

    return Response.json({
      session_id: sessionId,
      room_name: roomName,
      server_url: livekitUrl,
      participant_token: await participantToken.toJwt(),
      agent: { id: agent.id, name: agent.name },
    })
  } catch (error) {
    await context.supabase
      .from("sessions")
      .update({ status: "failed", ended_at: new Date().toISOString() })
      .eq("id", sessionId)
    return errorResponse(error instanceof Error ? error.message : "Could not start the LiveKit session.", 502)
  }
}

/** Update a browser session as the room connects or disconnects. */
async function updateBrowserSession(request: Request, context: any, sessionId: string): Promise<Response> {
  let requestBody: { status?: unknown }
  try {
    requestBody = await request.json()
  } catch {
    return errorResponse("Request body must be valid JSON.", 400)
  }

  const status = requestBody.status
  if (typeof status !== "string" || !allowedStatuses.has(status)) {
    return errorResponse("Invalid session status.", 400)
  }

  const update: Record<string, string> = { status }
  if (status === "active") update.started_at = new Date().toISOString()
  if (["completed", "failed", "cancelled"].includes(status)) update.ended_at = new Date().toISOString()

  const { data, error } = await context.supabase
    .from("sessions")
    .update(update)
    .eq("id", sessionId)
    .select("id, status, started_at, ended_at")
    .single()

  if (error) return errorResponse(error.message, 500)
  return Response.json({ session: data })
}

/** Authenticate browser requests and route them to session creation or lifecycle updates. */
export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    const requestUrl = new URL(request.url)
    const sessionId = requestUrl.searchParams.get("id")

    if (request.method === "POST" && !sessionId) {
      try {
        return await createBrowserSession(request, context)
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : "Could not create a session.", 400)
      }
    }

    if (request.method === "PATCH" && sessionId) return updateBrowserSession(request, context, sessionId)
    return errorResponse("Use POST to create a session or PATCH with a session id to update one.", 405)
  }),
}
