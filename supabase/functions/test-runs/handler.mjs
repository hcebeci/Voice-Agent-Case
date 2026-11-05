import { UUID, statuses, validateReport, reportHash, encodeCursor, decodeCursor, manualInputHash, sameManualInput, summarizeLatency } from "./validation.mjs"

const fail = (error, status = 400) => Response.json({ error }, { status })
const columns = "id, scenario_id, scenario_name, execution_type, status, session_id, agent_id, configuration_version, policy_version, started_at, completed_at, created_at, latency, expected_outcome, actual_outcome, error_message, artifact_path, provenance"

/** Manual evidence is explicitly attributed to the reviewer; saved effects come from the DB. */
async function manualReport(body, context, inputHash) {
  if (body.execution_type !== "manual_audio") throw new Error("Automated reports require service authentication.")
  if (!UUID.test(body.session_id)) throw new Error("A saved synthetic session is required.")
  if (!statuses.has(body.status) || body.status === "not_run") throw new Error("Choose passed, failed or inconclusive.")
  const db = context.supabaseAdmin
  const { data: session, error } = await context.supabase.from("sessions").select("*").eq("id", body.session_id).single()
  if (error || !session) throw new Error("Session not found.")
  if (["connecting", "active"].includes(session.status)) throw new Error("End the call before recording its validation.")
  const { data: binding, error: bindingError } = await db.from("collection_sessions").select("customer_id,state").eq("session_id", body.session_id).maybeSingle()
  if (bindingError || !binding) throw new Error("Session is not a customer test.")
  const { data: customer, error: customerError } = await db.from("customers").select("*").eq("id", binding.customer_id).eq("is_test_record", true).maybeSingle()
  if (customerError || !customer) throw new Error("Only synthetic customer tests can be retained here.")
  const results = await Promise.all([
    db.from("session_turns").select("*").eq("session_id", body.session_id).order("turn_number"),
    db.from("payment_commitments").select("*").eq("session_id", body.session_id),
    db.from("follow_up_requests").select("*").eq("session_id", body.session_id),
    db.from("collection_operations").select("tool_name,result").eq("session_id", body.session_id),
  ])
  if (results.some(result => result.error)) throw new Error("Could not capture saved validation evidence.")
  const turns = results[0].data ?? []
  const latency = summarizeLatency(turns)
  const configuration = session.agent_configuration_snapshot
  return {
    id: body.id ?? crypto.randomUUID(), scenario_id: body.scenario_id, scenario_name: body.scenario_name,
    execution_type: "manual_audio", status: body.status, session_id: session.id, agent_id: session.agent_id,
    configuration_version: await reportHash(configuration), policy_version: binding.state?.policy?.version ?? customer.policy_version,
    configuration_snapshot: configuration, customer_snapshot: customer,
    expected_outcome: body.expected_outcome,
    actual_outcome: { session_status: session.status, commitments: results[1].data, callbacks: results[2].data, operations: results[3].data },
    transcript: turns.flatMap(turn => [{ role: "user", content: turn.user_transcript }, { role: "assistant", content: turn.agent_transcript }]).filter(message => message.content),
    latency,
    assertions: [], provenance: { manual_input_hash: inputHash, verdict_source: "human", recorded_by: context.userClaims.id, customer_snapshot_at: "validation_capture", missing_turn_latency_count: latency.missing_sample_count },
    started_at: session.started_at, completed_at: session.ended_at,
    notes: typeof body.notes === "string" ? body.notes : null,
    error_message: typeof body.error_message === "string" ? body.error_message : null,
  }
}

export async function handleTestRuns(request, context) {
  const url = new URL(request.url)
  const service = context.authMode === "secret"
  const reader = service ? context.supabaseAdmin : context.supabase
  try {
    if (request.method === "GET") {
      const id = url.searchParams.get("id")
      if (id) {
        if (!UUID.test(id)) return fail("Invalid run id.")
        const { data, error } = await reader.from("test_runs").select("*").eq("id", id).maybeSingle()
        if (error) return fail("Could not read validation history.", 503)
        return data ? Response.json({ run: data }) : fail("Run not found.", 404)
      }
      const requested = Number(url.searchParams.get("limit") ?? 20)
      const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 100)) : 20
      let query = reader.from("test_runs").select(columns).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit+1)
      if (url.searchParams.has("cursor")) {
        const cursor = decodeCursor(url.searchParams.get("cursor"))
        query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`)
      }
      const { data, error } = await query
      if (error) return fail("Could not read validation history.", 503)
      const rows = data ?? [], runs = rows.slice(0,limit)
      return Response.json({ runs, next_cursor: rows.length > limit ? encodeCursor(runs.at(-1)) : null })
    }
    if (request.method !== "POST") return fail("Use GET or POST. Retained runs cannot be edited or deleted.", 405)
    const body = await request.json()
    if (!service && body.execution_type !== "manual_audio") return fail("Automated reports require service authentication.", 403)
    let inputHash
    if (!service) {
      body.id ??= crypto.randomUUID()
      inputHash = await manualInputHash(body, context.userClaims.id)
      // A lost response must replay the first immutable capture even if late
      // transcripts or metrics arrived since that capture.
      const { data: saved, error: replayError } = await context.supabaseAdmin.from("test_runs")
        .select("*").eq("id", body.id).maybeSingle()
      if (replayError) return fail("Could not reconcile retained report.", 503)
      if (saved) return sameManualInput(saved, inputHash, context.userClaims.id, body.session_id)
        ? Response.json({ id: saved.id, duplicate: true, run: saved })
        : fail("This report id already belongs to different evidence.", 409)
    }
    const raw = service ? body : await manualReport(body, context, inputHash)
    validateReport(raw)
    const allowed = ["id","scenario_id","scenario_name","execution_type","status","session_id","agent_id","configuration_version","policy_version","configuration_snapshot","customer_snapshot","expected_outcome","actual_outcome","transcript","latency","assertions","provenance","error_message","artifact_path","notes","started_at","completed_at"]
    const report = Object.fromEntries(allowed.filter(key => raw[key] !== undefined).map(key => [key, raw[key]]))
    const hash = await reportHash(report)
    const { error } = await context.supabaseAdmin.from("test_runs").insert({ ...report, report_hash: hash, created_by: service ? null : context.userClaims.id })
    if (error?.code === "23505") {
      const { data: old, error: readError } = await context.supabaseAdmin.from("test_runs").select("*").eq("id", report.id).single()
      if (readError || !old) return fail("Could not reconcile retained report.", 503)
      const matches = service ? old.report_hash === hash : sameManualInput(old, inputHash, context.userClaims.id, body.session_id)
      return matches ? Response.json({ id: report.id, duplicate: true, run: old }) : fail("This report id already belongs to different evidence.", 409)
    }
    if (error) return fail("Could not retain validation report.", 503)
    return Response.json({ id: report.id, duplicate: false }, { status: 201 })
  } catch (error) { return fail(error instanceof Error ? error.message : "Invalid request.") }
}
