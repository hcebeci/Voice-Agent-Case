import test from "node:test"
import assert from "node:assert/strict"
import { validateReport, reportHash, encodeCursor, decodeCursor, summarizeLatency } from "./validation.mjs"

const report = () => ({ id: "00000000-0000-4000-8000-000000000001", scenario_id: "minimum-override", scenario_name: "Manager override", execution_type: "automated_text", status: "passed", configuration_version: "sha256:abc", policy_version: "collection-demo-v1", customer_snapshot: { is_test_record: true, date_of_birth: "1988-04-12", postal_code: "34000" }, expected_outcome: { commitments: [] }, actual_outcome: { commitments: [] }, transcript: [{ role: "user", content: "1988-04-12, 34000" }] })

test("missing audio latency stays unknown rather than becoming a zero sample", () => {
  const result = summarizeLatency([{total_latency_ms:100},{total_latency_ms:300},{total_latency_ms:null}])
  assert.equal(result.p50_ms,200)
  assert.equal(result.p95_ms,290)
  assert.equal(result.sample_count,2)
  assert.equal(result.missing_sample_count,1)
  assert.equal(result.complete,false)
  assert.equal(summarizeLatency([]).average_ms,null)
})

test("retained synthetic evidence preserves verification values", () => {
  const value = validateReport(report())
  assert.equal(value.customer_snapshot.date_of_birth, "1988-04-12")
  assert.equal(value.transcript[0].content, "1988-04-12, 34000")
})
test("rejects non-test customer reports and unknown verdicts", () => {
  assert.throws(() => validateReport({ ...report(), customer_snapshot: { is_test_record: false } }), /synthetic/)
  assert.throws(() => validateReport({ ...report(), status: "success" }), /status/)
  assert.throws(() => validateReport({ ...report(), execution_type: "pretend_audio" }), /execution_type/)
})
test("hash is independent of object property order but covers transcript and verdict", async () => {
  const one = report(), reversed = Object.fromEntries(Object.entries(one).reverse())
  assert.equal(await reportHash(one), await reportHash(reversed))
  assert.notEqual(await reportHash(one), await reportHash({ ...one, status: "failed" }))
  assert.notEqual(await reportHash(one), await reportHash({ ...one, transcript: [] }))
})
test("history cursors round trip and reject query injection", () => {
  const row = { created_at: "2026-11-05T10:00:00.000Z", id: report().id }
  assert.deepEqual(decodeCursor(encodeCursor(row)), row)
  assert.throws(() => decodeCursor(btoa(JSON.stringify({ ...row, id: "x),status.eq.passed" }))), /cursor/)
})
