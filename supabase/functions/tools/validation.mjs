const executionKeyPattern = /^[a-z][a-z0-9_.-]{1,79}$/;

/** Keep tool input limited to the fields owned by the tool library. */
export function pickToolFields(input, includeEnabled = false) {
  const fieldNames = ["name", "description", "execution_key", "input_schema"];
  if (includeEnabled) fieldNames.push("is_enabled");
  return Object.fromEntries(fieldNames.filter((fieldName) => fieldName in input).map((fieldName) => [fieldName, input[fieldName]]));
}

/** Validate one tool definition before it is stored or updated. */
export function validateToolFields(fields, { requireName = false } = {}) {
  if (requireName && (typeof fields.name !== "string" || !fields.name.trim())) return "Tool name is required.";
  if ("name" in fields && (typeof fields.name !== "string" || !fields.name.trim() || fields.name.trim().length > 80)) {
    return "Tool name must be between 1 and 80 characters.";
  }
  if ("description" in fields && typeof fields.description !== "string") return "Tool description must be text.";
  if ("execution_key" in fields && (typeof fields.execution_key !== "string" || !executionKeyPattern.test(fields.execution_key))) {
    return "Execution key must start with a letter and contain only lowercase letters, numbers, dots, hyphens, or underscores.";
  }
  if (
    "input_schema" in fields &&
    (!fields.input_schema || typeof fields.input_schema !== "object" || Array.isArray(fields.input_schema))
  ) return "Input schema must be a JSON object.";
  if ("is_enabled" in fields && typeof fields.is_enabled !== "boolean") return "is_enabled must be boolean.";
  return null;
}

/** Validate the complete assignment payload sent by the agent editor. */
export function validateAssignments(value) {
  if (!Array.isArray(value)) return "assignments must be an array.";
  const seenToolIds = new Set();
  for (const assignment of value) {
    if (!assignment || typeof assignment !== "object" || typeof assignment.tool_id !== "string") return "Each assignment needs a tool_id.";
    if (seenToolIds.has(assignment.tool_id)) return "A tool cannot be assigned more than once.";
    seenToolIds.add(assignment.tool_id);
    if (assignment.configuration != null && (typeof assignment.configuration !== "object" || Array.isArray(assignment.configuration))) {
      return "Tool configuration must be a JSON object.";
    }
  }
  return null;
}
