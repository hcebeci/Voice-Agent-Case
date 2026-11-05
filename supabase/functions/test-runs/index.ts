import { withSupabase } from "npm:@supabase/server"
import { handleTestRuns } from "./handler.mjs"

export default {
  fetch: withSupabase({ auth: ["user", "secret"] }, handleTestRuns),
}
