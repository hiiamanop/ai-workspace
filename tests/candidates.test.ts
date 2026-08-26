import { test } from "node:test";
import assert from "node:assert/strict";
import { availableCandidates, availableToolCandidates } from "../src/candidates.ts";

test("availableCandidates() throws when DEEPSEEK_API_KEY is not set", () => {
  assert.throws(() => availableCandidates({}), /DEEPSEEK_API_KEY not set/);
});

test("availableCandidates() returns the DeepSeek candidate when DEEPSEEK_API_KEY is set", () => {
  const candidates = availableCandidates({ DEEPSEEK_API_KEY: "sk-test" });
  assert.deepEqual(candidates.map((c) => c.id), ["deepseek-v4-flash"]);
});

test("availableToolCandidates() returns web_search and scrape as tool-kind candidates", () => {
  const candidates = availableToolCandidates();
  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));

  assert.equal(byId.web_search.kind, "tool");
  assert.equal(byId.scrape.kind, "tool");
});

test("availableCandidates() sets the DeepSeek candidate's context_window_tokens to 1,000,000", () => {
  const candidates = availableCandidates({ DEEPSEEK_API_KEY: "sk-test" });
  const deepseek = candidates.find((c) => c.id === "deepseek-v4-flash");
  assert.equal(deepseek?.context_window_tokens, 1_000_000);
});
