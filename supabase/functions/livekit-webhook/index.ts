import { withSupabase } from "npm:@supabase/server"
import { WebhookReceiver } from "npm:livekit-server-sdk"

type LiveKitEvent = {
  id?: string
  event?: string
  createdAt?: number
  room?: { name?: string }
  participant?: { identity?: string; kind?: string; state?: number }
}

const activeStatuses = ["connecting", "active"]
/** Return an error response without exposing secrets or raw verification details. */
function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

/** Convert LiveKit's UNIX seconds timestamp into a database timestamp. */
function eventTimestamp(event: LiveKitEvent): string {
  const seconds = typeof event.createdAt === "number" ? event.createdAt : Math.floor(Date.now() / 1000)
  return new Date(seconds * 1000).toISOString()
}

/** Record a readable lifecycle event for the session details page. */
async function appendSessionEvent(adminClient: any, sessionId: string, event: LiveKitEvent, occurredAt: string) {
  const { error } = await adminClient.from("session_events").insert({
    session_id: sessionId,
    event_type: `livekit.${event.event ?? "unknown"}`,
    occurred_at: occurredAt,
    received_at: new Date().toISOString(),
    source: "livekit_webhook",
    source_event_id: event.id ?? null,
    payload: event,
  })
  if (error) throw new Error(error.message)
}

/** Apply the verified room lifecycle event to the matching application session. */
async function updateSessionLifecycle(adminClient: any, event: LiveKitEvent, occurredAt: string) {
  const roomName = event.room?.name
  if (!roomName) return

  const { data: session, error: sessionError } = await adminClient
    .from("sessions")
    .select("id, status, started_at")
    .eq("room_name", roomName)
    .maybeSingle()
  if (sessionError) throw new Error(sessionError.message)
  if (!session) return

  await appendSessionEvent(adminClient, session.id, event, occurredAt)

  const eventName = event.event ?? ""
  const lifecycleUpdate: Record<string, string> = { last_livekit_event_at: occurredAt }
  let allowedCurrentStatuses = activeStatuses

  if (eventName === "room_started" || eventName === "participant_joined") {
    lifecycleUpdate.status = "active"
    if (!session.started_at) lifecycleUpdate.started_at = occurredAt
  } else if (eventName === "room_finished") {
    lifecycleUpdate.status = "completed"
    lifecycleUpdate.ended_at = occurredAt
    allowedCurrentStatuses = activeStatuses
  } else if (eventName === "participant_connection_aborted" && session.status === "connecting") {
    lifecycleUpdate.status = "failed"
    lifecycleUpdate.ended_at = occurredAt
    allowedCurrentStatuses = ["connecting"]
  } else {
    await adminClient.from("sessions").update({ last_livekit_event_at: occurredAt }).eq("id", session.id)
    return
  }

  const { error: updateError } = await adminClient
    .from("sessions")
    .update(lifecycleUpdate)
    .eq("id", session.id)
    .in("status", allowedCurrentStatuses)
  if (updateError) throw new Error(updateError.message)
}

/** Verify and persist one LiveKit webhook delivery exactly once. */
async function processWebhook(request: Request, context: any): Promise<Response> {
  const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY")
  const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET")
  if (!livekitApiKey || !livekitApiSecret) return errorResponse("LiveKit webhook verification is not configured.", 503)

  const rawBody = await request.text()
  const authorization = request.headers.get("Authorization") ?? undefined
  let event: LiveKitEvent
  try {
    const receiver = new WebhookReceiver(livekitApiKey, livekitApiSecret)
    event = await receiver.receive(rawBody, authorization)
  } catch {
    return errorResponse("Invalid LiveKit webhook signature.", 401)
  }

  if (!event.id || !event.event) return errorResponse("LiveKit webhook is missing its event id or type.", 400)
  const occurredAt = eventTimestamp(event)
  const roomName = event.room?.name ?? null
  const { data: insertedEvent, error: insertError } = await context.supabaseAdmin
    .from("livekit_webhook_events")
    .insert({
      event_id: event.id,
      event_type: event.event,
      room_name: roomName,
      occurred_at: occurredAt,
      payload: event,
    })
    .select("event_id")
    .maybeSingle()

  let retryingUnprocessedEvent = false
  if (insertError?.code === "23505") {
    const { data: existingEvent, error: existingEventError } = await context.supabaseAdmin
      .from("livekit_webhook_events")
      .select("processed_at")
      .eq("event_id", event.id)
      .maybeSingle()
    if (existingEventError) return errorResponse(existingEventError.message, 500)
    if (existingEvent?.processed_at) return Response.json({ received: true, duplicate: true })
    retryingUnprocessedEvent = true
  }
  if (insertError && insertError.code !== "23505") return errorResponse(insertError.message, 500)
  if (!insertedEvent && !retryingUnprocessedEvent) return errorResponse("Could not record the LiveKit webhook.", 500)

  try {
    await updateSessionLifecycle(context.supabaseAdmin, event, occurredAt)
    await context.supabaseAdmin
      .from("livekit_webhook_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("event_id", event.id)

    await context.supabaseAdmin
      .from("session_events")
      .update({ processed_at: new Date().toISOString(), processing_error: null })
      .eq("source", "livekit_webhook")
      .eq("source_event_id", event.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown webhook processing error."
    await context.supabaseAdmin
      .from("livekit_webhook_events")
      .update({ processing_error: message })
      .eq("event_id", event.id)
    return errorResponse("LiveKit webhook was received but could not be processed.", 500)
  }

  return Response.json({ received: true })
}

/** Receive signed LiveKit callbacks; platform JWT validation is disabled in config.toml. */
export default {
  fetch: withSupabase({ auth: "none" }, async (request, context) => {
    if (request.method !== "POST") return errorResponse("Method not allowed.", 405)
    return processWebhook(request, context)
  }),
}
