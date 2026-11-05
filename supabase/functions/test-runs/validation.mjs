export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const executionTypes = new Set(["manual_audio", "automated_scripted", "automated_text", "automated_audio", "integration"])
export const statuses = new Set(["passed", "failed", "inconclusive", "not_run"])

export function summarizeLatency(turns) {
  const values = turns.map(turn => turn.total_latency_ms).filter(value => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a,b) => a-b)
  const percentile = fraction => {
    if (!values.length) return null
    const position = (values.length-1)*fraction, lower = Math.floor(position), upper = Math.ceil(position)
    return values[lower]+(values[upper]-values[lower])*(position-lower)
  }
  return { source: "saved_audio_turns", sample_count: values.length, expected_turn_count: turns.length,
    missing_sample_count: turns.length-values.length, complete: turns.length > 0 && values.length === turns.length,
    average_ms: values.length ? values.reduce((a,b) => a+b,0)/values.length : null,
    p50_ms: percentile(0.5), p95_ms: percentile(0.95) }
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)

export function validateReport(value) {
  if (!object(value)) throw new Error("A report object is required.")
  for (const field of ["scenario_id", "scenario_name", "configuration_version", "policy_version"]) {
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 500) throw new Error(`Invalid ${field}.`)
  }
  if (!UUID.test(value.id)) throw new Error("Invalid report id.")
  if (!statuses.has(value.status)) throw new Error("Invalid status.")
  if (!executionTypes.has(value.execution_type)) throw new Error("Invalid execution_type.")
  if (!object(value.customer_snapshot) || value.customer_snapshot.is_test_record !== true) throw new Error("Only synthetic customer reports are accepted.")
  if (!object(value.expected_outcome) || !object(value.actual_outcome)) throw new Error("Expected and actual outcomes must be objects.")
  if (!Array.isArray(value.transcript)) throw new Error("Transcript must be an array.")
  if (value.session_id != null && !UUID.test(value.session_id)) throw new Error("Invalid session_id.")
  if (value.agent_id != null && !UUID.test(value.agent_id)) throw new Error("Invalid agent_id.")
  for (const name of ["started_at", "completed_at"]) {
    if (value[name] != null && (typeof value[name] !== "string" || !Number.isFinite(Date.parse(value[name])))) throw new Error(`Invalid ${name}.`)
  }
  if (value.started_at && value.completed_at && Date.parse(value.completed_at) < Date.parse(value.started_at)) throw new Error("Completion must follow start.")
  if (JSON.stringify(value).length > 2_000_000) throw new Error("Report exceeds the 2 MB limit.")
  return value
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export async function reportHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("")
}
export function encodeCursor(row) {
  return btoa(JSON.stringify({ created_at: row.created_at, id: row.id })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}
export function decodeCursor(raw) {
  try {
    const value = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/")))
    if (!UUID.test(value.id) || typeof value.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|\+00:00)$/.test(value.created_at) || !Number.isFinite(Date.parse(value.created_at))) throw new Error()
    return { created_at: value.created_at, id: value.id }
  } catch { throw new Error("Invalid history cursor.") }
}

/** Bind manual retries to the reviewer's submitted input, not changing telemetry. */
export async function manualInputHash(body, ownerId) {
  if (!object(body) || !UUID.test(body.id) || !UUID.test(body.session_id)) throw new Error("Valid report and session ids are required.")
  return reportHash({ recorded_by: ownerId, input: body })
}

export function sameManualInput(saved, hash, ownerId, sessionId) {
  return saved?.execution_type === "manual_audio" && saved.created_by === ownerId &&
    saved.session_id === sessionId && saved.provenance?.manual_input_hash === hash
}
