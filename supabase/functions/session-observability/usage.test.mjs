import assert from "node:assert/strict";
import test from "node:test";
import { usageTokenTotals } from "./usage.mjs";

test("aggregates LLM token entries and ignores speech model usage", () => {
  assert.deepEqual(
    usageTokenTotals({
      usage: {
        model_usage: [
          { type: "llm_usage", input_tokens: 120, output_tokens: 30 },
          { type: "llm_usage", input_tokens: 80, output_tokens: 20 },
          { type: "tts_usage", input_tokens: 999, output_tokens: 999 },
        ],
      },
    }),
    { input: 200, output: 50 },
  );
});

test("accepts the camelCase format used by some serialized providers", () => {
  assert.deepEqual(
    usageTokenTotals({ usage: { modelUsage: [{ type: "llm_usage", inputTokens: 12, outputTokens: 4 }] } }),
    { input: 12, output: 4 },
  );
});

test("returns zero for missing or invalid usage data", () => {
  assert.deepEqual(usageTokenTotals({}), { input: 0, output: 0 });
  assert.deepEqual(
    usageTokenTotals({ usage: { model_usage: [{ type: "llm_usage", input_tokens: -2, output_tokens: "bad" }] } }),
    { input: 0, output: 0 },
  );
});
