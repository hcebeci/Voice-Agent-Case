import { callDirection } from "./configuration.mjs"
import { withSupabase } from "npm:@supabase/server"
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "npm:livekit-server-sdk"

type SessionRequest = {
  agent_id?: unknown
  source?: unknown
  customer_id?: unknown
  call_direction?: unknown
}

const allowedStatuses = new Set(["completed", "failed", "cancelled"])

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
  const requestKey = request.headers.get("Idempotency-Key")?.trim()
  if (!requestKey || requestKey.length < 8 || requestKey.length > 200) {
    return Response.json({ code: "IDEMPOTENCY_KEY_REQUIRED", error: "Supply an Idempotency-Key between 8 and 200 characters." }, { status: 400 })
  }
  const requestBody = await parseSessionRequest(request)
  const agentId = typeof requestBody.agent_id === "string" ? requestBody.agent_id : ""
  const source = requestBody.source ?? "user_started"
  const direction = callDirection(requestBody.call_direction)
  const customerId = requestBody.customer_id
  if (customerId !== undefined && (typeof customerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId))) {
    return errorResponse("A valid customer id is required.", 400)
  }
  if (!agentId) return errorResponse("An agent id is required.", 400)
  if (source !== "user_started") return errorResponse("Only user_started sessions are supported in the browser MVP.", 400)

  const livekitUrl = Deno.env.get("LIVEKIT_URL")
  const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY")
  const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET")
  if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
    return errorResponse("LiveKit is not configured on the session function.", 503)
  }

  const { data: reservation, error: reserveError } = await context.supabaseAdmin.rpc("session_start_reserve", {
    p_user_id: context.userClaims.id, p_key: requestKey,
    p_payload: { agent_id: agentId, source, customer_id: customerId ?? null, call_direction: direction },
    // Compatibility parameter: the database captures configuration under its row lock.
    p_snapshot: {},
  })
  if (reserveError || !reservation) return errorResponse("Could not reserve session. Retry with the same request key.", 503)
  if (reservation.code === "IDEMPOTENCY_KEY_REUSED") {
    return Response.json({ code: reservation.code, error: "This request key was already used with different session settings." }, { status: 409 })
  }
  const reservationErrors: Record<string, [string, number]> = {
    AGENT_NOT_FOUND: ["The selected agent could not be found.", 404],
    AGENT_OFFLINE: ["This agent is offline. Activate it before starting a session.", 409],
    CUSTOMER_NOT_FOUND: ["Customer not found.", 404],
    AGENT_TOOL_INVALID: ["This agent has an enabled tool without a worker implementation.", 400],
    AGENT_TOOL_PREREQUISITES: ["Payment tools require verify_identity; commitments also require evaluate_offer.", 400],
    INVALID_SESSION_REQUEST: ["Invalid session settings.", 400],
  }
  if (reservation.code) {
    const [message, status] = reservationErrors[reservation.code] ?? ["Could not reserve session.", 503]
    return errorResponse(message, status)
  }
  const sessionId = reservation.session_id
  const roomName = reservation.room_name
  if (!["connecting", "active"].includes(reservation.status)) {
    return Response.json({ code: "SESSION_CLOSED", error: "This call has ended. Start a new call with a new request key." }, { status: 409 })
  }
  // Replays use the original saved configuration even if the editor changed meanwhile.
  const snapshot = reservation.snapshot
  const apiHost = livekitApiHost(livekitUrl)
  const dispatchClient = new AgentDispatchClient(apiHost, livekitApiKey, livekitApiSecret)
  const pending = () => Response.json({ code: "SESSION_START_PENDING", session_id: sessionId,
    error: "Call start is awaiting confirmation. Retry with the same request key." }, { status: 202 })
  const markReady = async () => {
    const { error } = await context.supabaseAdmin.rpc("session_start_dispatch", {
      p_user_id: context.userClaims.id, p_key: requestKey, p_ready: true,
    })
    if (error) throw new Error("Could not persist dispatch confirmation.")
  }
  const reconcile = async () => {
    // Official SDK: listDispatch(roomName) returns AgentDispatch[]. Never create on a replay.
    const dispatches = await dispatchClient.listDispatch(roomName)
    const confirmed = dispatches.some((dispatch: any) => {
      try { return dispatch.agentName === "Voice-Agent-Case" && JSON.parse(dispatch.metadata).session_id === sessionId }
      catch { return false }
    })
    if (confirmed) await markReady()
    return confirmed
  }
  try {
    if (reservation.dispatch_state !== "ready") {
      if (reservation.dispatch_state === "reserved") {
        const roomService = new RoomServiceClient(apiHost, livekitApiKey, livekitApiSecret)
        await roomService.createRoom({ name: roomName, emptyTimeout: 30, departureTimeout: 20, maxParticipants: 4 })
        const { data: ownsDispatch, error } = await context.supabaseAdmin.rpc("session_start_dispatch", {
          p_user_id: context.userClaims.id, p_key: requestKey, p_ready: false,
        })
        if (error) return pending()
        if (ownsDispatch) {
          try {
            await dispatchClient.createDispatch(roomName, "Voice-Agent-Case", {
              metadata: JSON.stringify({ ...snapshot, customer_bound: Boolean(snapshot.customer_id),
                customer_id: undefined, session_id: sessionId, agent_id: snapshot.id, agent_name: snapshot.name,
                source: snapshot.call_direction === "agent_calls_user" ? "platform_started" : "user_started" }),
            })
            await markReady()
          } catch {
            if (!await reconcile()) return pending()
          }
        } else if (!await reconcile()) return pending()
      } else if (!await reconcile()) return pending()
    }
    const participantToken = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: `user-${context.userClaims.id}-${sessionId.slice(0, 8)}`, name: "User", ttl: "2h",
    })
    participantToken.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })
    return Response.json({ session_id: sessionId, room_name: roomName, server_url: livekitUrl,
      participant_token: await participantToken.toJwt(), agent: { id: snapshot.id, name: snapshot.name } })
  } catch {
    // Neither a timeout nor a failed receipt write proves the dispatch did not happen.
    return pending()
  }
}

/** Close the authenticated caller's session through the owner-bound state transition. */
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

  const { data, error } = await context.supabaseAdmin.rpc("close_browser_session", {
    p_user_id: context.userClaims.id, p_session_id: sessionId, p_status: status,
  })
  if (error) return errorResponse("Could not close session.", 500)
  if (data?.code === "SESSION_NOT_FOUND") return errorResponse("Session not found.", 404)
  if (data?.code === "SESSION_CLOSED") return errorResponse("This session has already ended.", 409)
  if (data?.code) return errorResponse("Invalid session transition.", 400)
  return Response.json(data)
}

/** Authenticate browser requests and route them to session creation or lifecycle updates. */
export default {
  fetch: withSupabase({ auth: "user", cors: { headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
    "Access-Control-Allow-Methods": "POST, PATCH, OPTIONS",
  } } }, async (request, context) => {
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
