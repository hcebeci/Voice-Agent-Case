import { withSupabase } from "npm:@supabase/server"

// The test panel deliberately exposes verification answers only for fictional fixtures.
export default {
  fetch: withSupabase({ auth: "user" }, async (request, context) => {
    if (request.method !== "GET") return Response.json({ error: "Method not allowed." }, { status: 405 })
    const { data: customers, error } = await context.supabaseAdmin.from("customers")
      .select("id, full_name, date_of_birth, postal_code, timezone, account_reference, balance_cents, currency, payment_due_date, late_interest_cents, credit_reporting_status, phone_e164")
      .eq("is_test_record", true).order("full_name")
    if (error) return Response.json({ error: "Could not load test customers." }, { status: 503 })
    const { data: contexts, error: stageError } = await context.supabaseAdmin.from("customer_collection_context")
      .select("id, collection_stage, days_overdue").eq("is_test_record", true)
    if (stageError) return Response.json({ error: "Could not load collection stages." }, { status: 503 })
    const stages = new Map((contexts ?? []).map(row => [row.id, row]))
    return Response.json({ customers: (customers ?? []).map(customer => ({ ...customer, ...stages.get(customer.id) })) })
  }),
}
