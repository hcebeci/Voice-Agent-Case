import { withSupabase } from "npm:@supabase/server"
import { usageTokenTotals } from "./usage.mjs"

type ObservabilityEvent = {
  event_id?: unknown
  session_id?: unknown
  event_type?: unknown
  occurred_at?: unknown
  turn_number?: unknown
  sequence_number?: unknown
  payload?: unknown
}

type EventContext = {
  event_id: string
  session_id: string
  event_type: string
  occurred_at: string
  turn_number: number | null
  sequence_number: number | null
  payload: Record<string, unknown>
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null
  return value
}

function asTimestamp(value: unknown): string {
  if (typeof value !== "string") return new Date().toISOString()
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString()
}

function parseEvent(value: ObservabilityEvent): EventContext | null {
  if (
    typeof value.event_id !== "string" ||
    typeof value.session_id !== "string" ||
    typeof value.event_type !== "string"
  ) return null

  const turnNumber = value.turn_number == null ? null : asPositiveInteger(value.turn_number)
  if (value.turn_number != null && turnNumber == null) return null

  const sequenceNumber = value.sequence_number == null ? null : asPositiveInteger(value.sequence_number)
  if (value.sequence_number != null && sequenceNumber == null) return null

  return {
    event_id: value.event_id,
    session_id: value.session_id,
    event_type: value.event_type,
    occurred_at: asTimestamp(value.occurred_at),
    turn_number: turnNumber,
    sequence_number: sequenceNumber,
    payload: asObject(value.payload),
  }
}

async function upsertTurn(adminClient: any, event: EventContext, values: Record<string, unknown>) {
  if (!event.turn_number) return null
  const { data, error } = await adminClient
    .from("session_turns")
    .upsert({
      session_id: event.session_id,
      turn_number: event.turn_number,
      ...values,
    }, { onConflict: "session_id,turn_number" })
    .select("id, user_speech_stopped_at")
    .single()
  if (error) throw new Error(error.message)
  return data
}

async function findTurnId(adminClient: any, event: EventContext): Promise<string | null> {
  if (!event.turn_number) return null
  const { data, error } = await adminClient
    .from("session_turns")
    .select("id")
    .eq("session_id", event.session_id)
    .eq("turn_number", event.turn_number)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data?.id ?? null
}

async function materializeTurnEvent(adminClient: any, event: EventContext) {
  const payload = event.payload
  if (event.event_type === "turn.user_speech_stopped") {
    await upsertTurn(adminClient, event, { user_speech_stopped_at: event.occurred_at })
    return
  }

  if (event.event_type === "turn.transcript_completed") {
    await upsertTurn(adminClient, event, {
      user_transcript: typeof payload.transcript === "string" ? payload.transcript : "",
      transcript_completed_at: event.occurred_at,
    })
    return
  }

  if (event.event_type === "turn.response_ready") {
    await upsertTurn(adminClient, event, {
      agent_transcript: typeof payload.transcript === "string" ? payload.transcript : "",
      response_ready_at: event.occurred_at,
    })
    return
  }

  if (event.event_type === "turn.agent_audio_started") {
    const turn = await upsertTurn(adminClient, event, {
      agent_first_audio_started_at: event.occurred_at,
    })
    const speechStoppedAt = turn?.user_speech_stopped_at
    const totalLatencyMs = speechStoppedAt
      ? Math.max(0, Math.round(new Date(event.occurred_at).valueOf() - new Date(speechStoppedAt).valueOf()))
      : null
    if (totalLatencyMs != null) {
      const { error } = await adminClient
        .from("session_turns")
        .update({ total_latency_ms: totalLatencyMs })
        .eq("id", turn.id)
      if (error) throw new Error(error.message)
    }
    return
  }

  if (event.event_type === "turn.completed") {
    await upsertTurn(adminClient, event, {
      status: "completed",
      completed_at: event.occurred_at,
    })
    return
  }

  if (event.event_type === "turn.cancelled") {
    await upsertTurn(adminClient, event, {
      status: "cancelled",
      completed_at: event.occurred_at,
    })
  }
}

async function materializeTrace(adminClient: any, event: EventContext) {
  const payload = event.payload
  const traceId = typeof payload.trace_id === "string" ? payload.trace_id : crypto.randomUUID()
  const turnId = await findTurnId(adminClient, event)
  const startedAt = asTimestamp(payload.started_at ?? event.occurred_at)
  const endedAt = payload.ended_at == null ? null : asTimestamp(payload.ended_at)
  const durationMs = typeof payload.duration_ms === "number" && payload.duration_ms >= 0
    ? Math.round(payload.duration_ms)
    : endedAt
      ? Math.max(0, Math.round(new Date(endedAt).valueOf() - new Date(startedAt).valueOf()))
      : null

  const { error } = await adminClient.from("session_traces").upsert({
    id: traceId,
    session_id: event.session_id,
    turn_id: turnId,
    event_type: event.event_type,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    status: payload.status === "failed" ? "failed" : endedAt ? "completed" : "running",
    metadata: asObject(payload.metadata),
    raw_payload: payload,
    source: "agent_worker",
    source_event_id: event.event_id,
    sequence_number: event.sequence_number,
  }, { onConflict: "source,source_event_id" })
  if (error) throw new Error(error.message)
}

async function materializeToolCall(adminClient: any, event: EventContext) {
  const payload = event.payload
  const callId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : event.event_id
  const sourceEventId = `${event.session_id}:${callId}`
  const turnId = await findTurnId(adminClient, event)
  const baseValues = {
    session_id: event.session_id,
    turn_id: turnId,
    tool_name: typeof payload.tool_name === "string" ? payload.tool_name : "unknown",
    arguments: asObject(payload.arguments),
    source: "agent_worker",
    source_event_id: sourceEventId,
    sequence_number: event.sequence_number,
  }

  if (event.event_type === "tool.started") {
    const { error } = await adminClient.from("tool_calls").upsert({
      ...baseValues,
      status: "started",
      started_at: event.occurred_at,
    }, { onConflict: "source,source_event_id" })
    if (error) throw new Error(error.message)
    return
  }

  const status = event.event_type === "tool.failed" ? "failed" : "succeeded"
  const completedAt = event.occurred_at
  const { data: existing, error: existingError } = await adminClient
    .from("tool_calls")
    .select("id, started_at")
    .eq("source", "agent_worker")
    .eq("source_event_id", sourceEventId)
    .maybeSingle()
  if (existingError) throw new Error(existingError.message)

  const durationMs = existing?.started_at
    ? Math.max(0, Math.round(new Date(completedAt).valueOf() - new Date(existing.started_at).valueOf()))
    : null
  const { error } = await adminClient
    .from("tool_calls")
    .update({
      status,
      completed_at: completedAt,
      duration_ms: durationMs,
      result: payload.result ?? null,
      error_message: typeof payload.error_message === "string" ? payload.error_message : null,
    })
    .eq("source", "agent_worker")
    .eq("source_event_id", sourceEventId)
  if (error) throw new Error(error.message)
}

/** Detect a repeated cumulative usage snapshot even when a retry has a new event ID. */
async function isDuplicateSessionUsage(adminClient: any, event: EventContext): Promise<boolean> {
  if (event.event_type !== "session.usage") return false

  const totals = usageTokenTotals(event.payload)
  const { data: metric, error: metricError } = await adminClient
    .from("session_metrics")
    .select("total_input_tokens, total_output_tokens")
    .eq("session_id", event.session_id)
    .maybeSingle()
  if (metricError) throw new Error(metricError.message)
  if (
    metric &&
    metric.total_input_tokens === totals.input &&
    metric.total_output_tokens === totals.output
  ) return true

  // A previous event may exist after a partial materialization failure, so also
  // compare recent receipts before deciding that this snapshot is new.
  const { data: recentEvents, error: eventError } = await adminClient
    .from("session_events")
    .select("source_event_id, payload")
    .eq("session_id", event.session_id)
    .eq("event_type", "session.usage")
    .neq("source_event_id", event.event_id)
    .order("occurred_at", { ascending: false })
    .limit(50)
  if (eventError) throw new Error(eventError.message)
  return (recentEvents ?? []).some((receipt: any) => {
    const previousTotals = usageTokenTotals(asObject(receipt.payload))
    return previousTotals.input === totals.input && previousTotals.output === totals.output
  })
}

/** Persist cumulative session usage for agent-level token metrics. */
async function materializeSessionUsage(adminClient: any, event: EventContext) {
  const totals = usageTokenTotals(event.payload)
  const { data: existing, error: existingError } = await adminClient
    .from("session_metrics")
    .select("total_input_tokens, total_output_tokens, captured_at")
    .eq("session_id", event.session_id)
    .maybeSingle()
  if (existingError) throw new Error(existingError.message)

  const inputTokens = Math.max(existing?.total_input_tokens ?? 0, totals.input)
  const outputTokens = Math.max(existing?.total_output_tokens ?? 0, totals.output)
  const isOlderSnapshot = existing && inputTokens === existing.total_input_tokens && outputTokens === existing.total_output_tokens
  const { error } = await adminClient.from("session_metrics").upsert({
    session_id: event.session_id,
    total_input_tokens: inputTokens,
    total_output_tokens: outputTokens,
    captured_at: isOlderSnapshot ? existing.captured_at : event.occurred_at,
  }, { onConflict: "session_id" })
  if (error) throw new Error(error.message)
}

async function materialize(adminClient: any, event: EventContext) {
  if (event.event_type.startsWith("turn.")) await materializeTurnEvent(adminClient, event)
  if (event.event_type.startsWith("trace.")) await materializeTrace(adminClient, event)
  if (event.event_type.startsWith("tool.")) await materializeToolCall(adminClient, event)
  if (event.event_type === "session.usage") await materializeSessionUsage(adminClient, event)
}

async function processEvent(adminClient: any, event: EventContext): Promise<boolean> {
  const { data: existing, error: existingError } = await adminClient
    .from("session_events")
    .select("processed_at")
    .eq("source", "agent_worker")
    .eq("source_event_id", event.event_id)
    .maybeSingle()
  if (existingError) throw new Error(existingError.message)
  if (existing?.processed_at) return true

  const { error: insertError } = await adminClient.from("session_events").insert({
    session_id: event.session_id,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    received_at: new Date().toISOString(),
    source: "agent_worker",
    source_event_id: event.event_id,
    sequence_number: event.sequence_number,
    payload: event.payload,
  })
  if (insertError && insertError.code !== "23505") throw new Error(insertError.message)
  const isSourceEventRetry = insertError?.code === "23505"

  try {
    const duplicateUsage = !isSourceEventRetry && await isDuplicateSessionUsage(adminClient, event)
    if (!duplicateUsage) await materialize(adminClient, event)
    const { error } = await adminClient
      .from("session_events")
      .update({ processed_at: new Date().toISOString(), processing_error: null })
      .eq("source", "agent_worker")
      .eq("source_event_id", event.event_id)
    if (error) throw new Error(error.message)
    if (duplicateUsage) return true
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown materialization error."
    await adminClient
      .from("session_events")
      .update({ processing_error: message })
      .eq("source", "agent_worker")
      .eq("source_event_id", event.event_id)
    throw new Error(message)
  }

  return false
}

export default {
  fetch: withSupabase({ auth: "secret" }, async (request, context) => {
    if (request.method !== "POST") return errorResponse("Method not allowed.", 405)

    let body: ObservabilityEvent
    try {
      body = await request.json()
    } catch {
      return errorResponse("Request body must be valid JSON.", 400)
    }

    const event = parseEvent(body)
    if (!event) return errorResponse("Invalid observability event.", 400)

    try {
      const duplicate = await processEvent(context.supabaseAdmin, event)
      return Response.json({ received: true, duplicate })
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Could not process observability event.", 500)
    }
  }),
}
