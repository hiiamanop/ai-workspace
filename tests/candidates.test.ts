import { test } from "node:test";
import assert from "node:assert/strict";
import { availableCandidates } from "../src/candidates.ts";

test("availableCandidates() always includes the local Ollama candidate", () => {
  const candidates = availableCandidates({});
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes("gemma4-12b"));
});

test("availableCandidates() includes DeepSeek only when DEEPSEEK_API_KEY is set", () => {
  const withoutKey = availableCandidates({});
  assert.ok(!withoutKey.map((c) => c.id).includes("deepseek-v4-flash"));

  const withKey = availableCandidates({ DEEPSEEK_API_KEY: "sk-test" });
  assert.ok(withKey.map((c) => c.id).includes("deepseek-v4-flash"));
});
