import { withSupabase } from "npm:@supabase/server"

/** Calculate a percentile from the completed turn latency values. */
function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = (sorted.length - 1) * percentileValue
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.ceil(index)
  if (lowerIndex === upperIndex) return sorted[lowerIndex]
  const weight = index - lowerIndex
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight
}

/** Build the latency and usage summary shown on a session details page. */
function buildSessionMetrics(turns: any[], sessionMetric: any | null) {
  const latencies = turns
    .map((turn) => turn.total_latency_ms)
    .filter((latency): latency is number => typeof latency === "number" && latency >= 0)
  const tokenTotals = sessionMetric
    ? {
      input: sessionMetric.total_input_tokens ?? 0,
      output: sessionMetric.total_output_tokens ?? 0,
    }
    : turns.reduce(
      (totals, turn) => ({
        input: totals.input + (turn.input_tokens ?? 0),
        output: totals.output + (turn.output_tokens ?? 0),
      }),
      { input: 0, output: 0 },
    )
  return {
    turn_count: turns.length,
    completed_turn_count: turns.filter((turn) => turn.status === "completed").length,
    average_latency_ms: latencies.length
      ? latencies.reduce((total, latency) => total + latency, 0) / latencies.length
      : null,
    p50_latency_ms: percentile(latencies, 0.5),
    p95_latency_ms: percentile(latencies, 0.95),
    total_input_tokens: tokenTotals.input,
    total_output_tokens: tokenTotals.output,
  }
}

/** Load one session together with all persisted observability records. */
async function loadSessionDetails(supabaseClient: any, sessionId: string): Promise<Response> {
  const [sessionResult, turnsResult, tracesResult, toolsResult, eventsResult, sessionMetricResult] = await Promise.all([
    supabaseClient
      .from("sessions")
      .select("id, agent_id, room_name, source, status, started_at, ended_at, created_at, agent_configuration_snapshot, agents(id, name)")
      .eq("id", sessionId)
      .maybeSingle(),
    supabaseClient
      .from("session_turns")
      .select("id, turn_number, user_transcript, agent_transcript, user_speech_stopped_at, transcript_completed_at, model_started_at, model_first_token_at, model_completed_at, response_ready_at, agent_first_audio_started_at, total_latency_ms, status, input_tokens, output_tokens, completed_at, created_at")
      .eq("session_id", sessionId)
      .order("turn_number"),
    supabaseClient
      .from("session_traces")
      .select("id, turn_id, parent_trace_id, event_type, started_at, ended_at, duration_ms, status, metadata, raw_payload")
      .eq("session_id", sessionId)
      .order("started_at"),
    supabaseClient
      .from("tool_calls")
      .select("id, turn_id, tool_id, tool_name, status, arguments, result, error_message, started_at, completed_at, duration_ms, trace_id")
      .eq("session_id", sessionId)
      .order("started_at"),
    supabaseClient
      .from("session_events")
      .select("id, turn_id, event_type, source, source_event_id, occurred_at, received_at, processed_at, processing_error, sequence_number, payload")
      .eq("session_id", sessionId)
      .order("occurred_at"),
    supabaseClient
      .from("session_metrics")
      .select("session_id, total_input_tokens, total_output_tokens, captured_at")
      .eq("session_id", sessionId)
      .maybeSingle(),
  ])

  const firstError = [
    sessionResult.error,
    turnsResult.error,
    tracesResult.error,
    toolsResult.error,
    eventsResult.error,
    sessionMetricResult.error,
  ].find(Boolean)
  if (firstError) return Response.json({ error: firstError.message }, { status: 500 })
  if (!sessionResult.data) return Response.json({ error: "Session not found." }, { status: 404 })

  const turns = turnsResult.data ?? []
  return Response.json({
    session: sessionResult.data,
    turns,
    traces: tracesResult.data ?? [],
    tool_calls: toolsResult.data ?? [],
    events: eventsResult.data ?? [],
    metrics: buildSessionMetrics(turns, sessionMetricResult.data ?? null),
  })
}

/** Return the session history visible to the authenticated workspace user. */
export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed." }, { status: 405 })
    }

    const requestUrl = new URL(request.url)
    const sessionId = requestUrl.searchParams.get("id")
    if (sessionId) return loadSessionDetails(context.supabase, sessionId)

    const agentId = requestUrl.searchParams.get("agent_id")
    const requestedLimit = Number(requestUrl.searchParams.get("limit") ?? "50")
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50

    let sessionQuery = context.supabase
      .from("sessions")
      .select("id, agent_id, room_name, source, status, started_at, ended_at, created_at, agents(id, name)")
      .order("created_at", { ascending: false })
      .limit(limit)

    if (agentId) sessionQuery = sessionQuery.eq("agent_id", agentId)

    const { data, error } = await sessionQuery
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ sessions: data ?? [] })
  }),
}
