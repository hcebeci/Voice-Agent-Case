import { withSupabase } from "npm:@supabase/server"

/** Derive the dashboard badge from archived state and currently connected sessions. */
function addRuntimeStatus(agents: any[], activeSessions: any[]) {
  const activeSessionCounts = new Map<string, number>()
  for (const session of activeSessions) {
    activeSessionCounts.set(
      session.agent_id,
      (activeSessionCounts.get(session.agent_id) ?? 0) + 1,
    )
  }

  return agents.map((agent) => {
    const activeSessionCount = activeSessionCounts.get(agent.id) ?? 0
    return {
      ...agent,
      active_session_count: activeSessionCount,
      runtime_status: agent.archived_at
        ? "offline"
        : activeSessionCount > 0
          ? "active"
          : "sleeping",
    }
  })
}

/** Mark sessions that never left the connecting state as failed after a short timeout. */
async function reconcileStaleConnectingSessions(supabaseClient: any) {
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { error } = await supabaseClient
    .from("sessions")
    .update({ status: "failed", ended_at: new Date().toISOString() })
    .eq("status", "connecting")
    .lt("created_at", staleBefore)
  if (error) throw new Error(error.message)
}

/** Close active sessions whose verified LiveKit lifecycle stopped reporting. */
async function reconcileStaleActiveSessions(supabaseClient: any) {
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString()
  const endedAt = new Date().toISOString()
  const { error: reportedSessionError } = await supabaseClient
    .from("sessions")
    .update({ status: "failed", ended_at: endedAt })
    .eq("status", "active")
    .not("last_livekit_event_at", "is", null)
    .lt("last_livekit_event_at", staleBefore)
  if (reportedSessionError) throw new Error(reportedSessionError.message)

  // Active rows created by an older deployment may not have a lifecycle
  // timestamp. Reconcile those only after the same conservative timeout.
  const { error: legacySessionError } = await supabaseClient
    .from("sessions")
    .update({ status: "failed", ended_at: endedAt })
    .eq("status", "active")
    .is("last_livekit_event_at", null)
    .lt("started_at", staleBefore)
  if (legacySessionError) throw new Error(legacySessionError.message)
}

/** Return the daily dashboard summary and the latest session timeline. */
export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed." }, { status: 405 })
    }

    const requestUrl = new URL(request.url)
    const requestedDate = requestUrl.searchParams.get("date")
    const dashboardDate = requestedDate ?? new Date().toISOString().slice(0, 10)
    const dayStart = new Date(`${dashboardDate}T00:00:00.000Z`)
    const nextDayStart = new Date(dayStart)
    nextDayStart.setUTCDate(nextDayStart.getUTCDate() + 1)

    try {
      await reconcileStaleConnectingSessions(context.supabase)
      await reconcileStaleActiveSessions(context.supabase)
    } catch (reconciliationError) {
      return Response.json({ error: (reconciliationError as Error).message }, { status: 500 })
    }

    const [agentsResult, activeSessionsResult, todaySessionsResult, latestSessionsResult] = await Promise.all([
      context.supabase.from("agents").select("id, name, archived_at"),
      context.supabase.from("sessions").select("agent_id").in("status", ["connecting", "active"]),
      context.supabase
        .from("sessions")
        .select("id, agent_id, room_name, source, status, started_at, ended_at, created_at, agents(id, name)")
        .gte("created_at", dayStart.toISOString())
        .lt("created_at", nextDayStart.toISOString())
        .order("created_at", { ascending: false }),
      context.supabase
        .from("sessions")
        .select("id, agent_id, room_name, source, status, started_at, ended_at, created_at, agents(id, name)")
        .order("created_at", { ascending: false })
        .limit(5),
    ])

    const firstError = [
      agentsResult.error,
      activeSessionsResult.error,
      todaySessionsResult.error,
      latestSessionsResult.error,
    ].find(Boolean)
    if (firstError) return Response.json({ error: firstError.message }, { status: 500 })

    const agents = addRuntimeStatus(agentsResult.data ?? [], activeSessionsResult.data ?? [])
    const availableAgents = agents.filter((agent) => agent.runtime_status !== "offline")

    return Response.json({
      date: dashboardDate,
      metrics: {
        total_sessions_today: todaySessionsResult.data?.length ?? 0,
        available_agent_count: availableAgents.length,
        active_agent_count: agents.filter((agent) => agent.runtime_status === "active").length,
        active_session_count: activeSessionsResult.data?.length ?? 0,
        sleeping_agent_count: agents.filter((agent) => agent.runtime_status === "sleeping").length,
        offline_agent_count: agents.filter((agent) => agent.runtime_status === "offline").length,
      },
      agents,
      today_sessions: todaySessionsResult.data ?? [],
      latest_sessions: latestSessionsResult.data ?? [],
    })
  }),
}
