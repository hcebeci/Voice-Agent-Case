import { withSupabase } from "npm:@supabase/server"

type NumericSummary = {
  count: number
  average_ms: number | null
  p50_ms: number | null
  p95_ms: number | null
}

/** Calculate a percentile using linear interpolation between observations. */
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

/** Summarize stage durations while preserving empty-stage information. */
function summarizeDurations(values: number[]): NumericSummary {
  return {
    count: values.length,
    average_ms: values.length ? values.reduce((total, value) => total + value, 0) / values.length : null,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
  }
}

/** Calculate the per-agent metrics used by the Agent Metric Page. */
function buildAgentMetrics(sessions: any[], turns: any[], traces: any[], tools: any[], sessionMetrics: any[]) {
  const turnsBySession = new Map<string, any[]>()
  for (const turn of turns) {
    const sessionTurns = turnsBySession.get(turn.session_id) ?? []
    sessionTurns.push(turn)
    turnsBySession.set(turn.session_id, sessionTurns)
  }

  const metricsBySession = new Map(sessionMetrics.map((metrics) => [metrics.session_id, metrics]))

  const sessionTokenTotals = sessions.map((session) => {
    const sessionTurns = turnsBySession.get(session.id) ?? []
    const storedMetrics = metricsBySession.get(session.id)
    return {
      known: Boolean(storedMetrics) || sessionTurns.some((turn) => (turn.input_tokens ?? 0) > 0 || (turn.output_tokens ?? 0) > 0),
      input: storedMetrics
        ? storedMetrics.total_input_tokens ?? 0
        : sessionTurns.reduce((total, turn) => total + (turn.input_tokens ?? 0), 0),
      output: storedMetrics
        ? storedMetrics.total_output_tokens ?? 0
        : sessionTurns.reduce((total, turn) => total + (turn.output_tokens ?? 0), 0),
    }
  })
  const knownTokenTotals = sessionTokenTotals.filter((tokens) => tokens.known)
  const averageTokens = (key: "input" | "output") => knownTokenTotals.length
    ? knownTokenTotals.reduce((total, tokens) => total + tokens[key], 0) / knownTokenTotals.length
    : null

  const stageValues = new Map<string, number[]>()
  const addStageDuration = (stage: string, duration: unknown) => {
    if (typeof duration !== "number" || duration < 0) return
    const values = stageValues.get(stage) ?? []
    values.push(duration)
    stageValues.set(stage, values)
  }

  for (const turn of turns) addStageDuration("end_to_end", turn.total_latency_ms)
  for (const trace of traces) {
    const stage = typeof trace.event_type === "string" && trace.event_type.startsWith("trace.")
      ? trace.event_type.slice("trace.".length)
      : null
    if (stage) addStageDuration(stage, trace.duration_ms)
  }
  for (const tool of tools) addStageDuration("tool", tool.duration_ms)

  const latencyByStage: Record<string, NumericSummary> = {}
  for (const [stage, values] of stageValues) latencyByStage[stage] = summarizeDurations(values)

  return {
    total_session_count: sessions.length,
    completed_session_count: sessions.filter((session) => session.status === "completed").length,
    concurrent_session_count: sessions.filter((session) => ["connecting", "active"].includes(session.status)).length,
    average_input_tokens_per_session: averageTokens("input"),
    average_output_tokens_per_session: averageTokens("output"),
    token_usage_session_count: sessionMetrics.length,
    latency_by_stage: latencyByStage,
  }
}

/** Load an agent and its session data for the Agent Metric Page. */
async function loadAgentMetrics(supabaseClient: any, agentId: string): Promise<Response> {
  const { data: agent, error: agentError } = await supabaseClient
    .from("agents")
    .select("id, name, description, language, archived_at")
    .eq("id", agentId)
    .maybeSingle()
  if (agentError) return Response.json({ error: agentError.message }, { status: 500 })
  if (!agent) return Response.json({ error: "Agent not found." }, { status: 404 })

  const { data: sessions, error: sessionsError } = await supabaseClient
    .from("sessions")
    .select("id, agent_id, source, status, started_at, ended_at, created_at, agents(id, name)")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
  if (sessionsError) return Response.json({ error: sessionsError.message }, { status: 500 })

  const allSessions = sessions ?? []
  const sessionIds = allSessions.map((session) => session.id)
  let turns: any[] = []
  let traces: any[] = []
  let tools: any[] = []
  let sessionMetrics: any[] = []

  if (sessionIds.length) {
    const [turnsResult, tracesResult, toolsResult, sessionMetricsResult] = await Promise.all([
      supabaseClient
        .from("session_turns")
        .select("session_id, total_latency_ms, input_tokens, output_tokens")
        .in("session_id", sessionIds),
      supabaseClient
        .from("session_traces")
        .select("session_id, event_type, duration_ms")
        .in("session_id", sessionIds),
      supabaseClient
        .from("tool_calls")
        .select("session_id, duration_ms")
        .in("session_id", sessionIds),
      supabaseClient
        .from("session_metrics")
        .select("session_id, total_input_tokens, total_output_tokens, captured_at")
        .in("session_id", sessionIds),
    ])
    const firstError = [turnsResult.error, tracesResult.error, toolsResult.error, sessionMetricsResult.error].find(Boolean)
    if (firstError) return Response.json({ error: firstError.message }, { status: 500 })
    turns = turnsResult.data ?? []
    traces = tracesResult.data ?? []
    tools = toolsResult.data ?? []
    sessionMetrics = sessionMetricsResult.data ?? []
  }

  return Response.json({
    agent,
    metrics: buildAgentMetrics(allSessions, turns, traces, tools, sessionMetrics),
    recent_sessions: allSessions.slice(0, 5),
  })
}

export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    if (request.method !== "GET") return Response.json({ error: "Method not allowed." }, { status: 405 })
    const agentId = new URL(request.url).searchParams.get("id")
    if (!agentId) return Response.json({ error: "An agent id is required." }, { status: 400 })
    return loadAgentMetrics(context.supabase, agentId)
  }),
}
