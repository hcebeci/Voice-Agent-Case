function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asNonNegativeNumber(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : 0;
}

/** Extract cumulative LLM input and output tokens from a LiveKit usage payload. */
export function usageTokenTotals(payload) {
  const usage = asObject(payload?.usage);
  const modelUsage = Array.isArray(usage.model_usage)
    ? usage.model_usage
    : Array.isArray(usage.modelUsage)
      ? usage.modelUsage
      : [];

  return modelUsage.reduce((totals, entry) => {
    const model = asObject(entry);
    if (model.type != null && model.type !== "llm_usage") return totals;
    return {
      input: totals.input + asNonNegativeNumber(model.input_tokens ?? model.inputTokens),
      output: totals.output + asNonNegativeNumber(model.output_tokens ?? model.outputTokens),
    };
  }, { input: 0, output: 0 });
}
