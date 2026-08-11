import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateContextTokens } from "../src/token-estimate.ts";

test("estimateContextTokens() grows with system prompt length", () => {
  const short = estimateContextTokens("hi", [], []);
  const long = estimateContextTokens("hi".repeat(1000), [], []);
  assert.ok(long > short);
});

test("estimateContextTokens() counts tool schema and message content", () => {
  const withoutExtras = estimateContextTokens("", [], []);
  const withExtras = estimateContextTokens(
    "",
    [{ type: "function", function: { name: "insert_content", description: "x".repeat(500), parameters: {} } }],
    [{ role: "user", content: "y".repeat(500) }]
  );
  assert.ok(withExtras > withoutExtras);
});

test("estimateContextTokens() always includes at least the response headroom buffer", () => {
  assert.ok(estimateContextTokens("", [], []) >= 1000);
});
