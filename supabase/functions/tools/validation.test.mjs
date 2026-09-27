import assert from "node:assert/strict";
import test from "node:test";
import { validateAssignments, validateToolFields } from "./validation.mjs";

test("accepts a valid backend tool definition", () => {
  assert.equal(validateToolFields({ name: "Current time", execution_key: "get_current_time", input_schema: {} }, { requireName: true }), null);
});

test("rejects unsafe execution keys", () => {
  assert.match(validateToolFields({ execution_key: "Run arbitrary code" }), /Execution key/);
});

test("rejects duplicate agent assignments", () => {
  assert.match(validateAssignments([{ tool_id: "tool-1" }, { tool_id: "tool-1" }]), /more than once/);
});
