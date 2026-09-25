import { withSupabase } from "npm:@supabase/server"

/** Return the session history visible to the authenticated workspace user. */
export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed." }, { status: 405 })
    }

    const requestUrl = new URL(request.url)
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
