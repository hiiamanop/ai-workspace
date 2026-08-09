import { test } from "node:test";
import assert from "node:assert/strict";
import { availableCandidates, availableToolCandidates } from "../src/candidates.ts";

test("availableCandidates() always includes the local Ollama candidate", () => {
  const candidates = availableCandidates({});
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes("gemma4:12b"));
});

test("availableCandidates() includes DeepSeek only when DEEPSEEK_API_KEY is set", () => {
  const withoutKey = availableCandidates({});
  assert.ok(!withoutKey.map((c) => c.id).includes("deepseek-v4-flash"));

  const withKey = availableCandidates({ DEEPSEEK_API_KEY: "sk-test" });
  assert.ok(withKey.map((c) => c.id).includes("deepseek-v4-flash"));
});

test("availableToolCandidates() returns web_search and scrape as tool-kind candidates", () => {
  const candidates = availableToolCandidates();
  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));

  assert.equal(byId.web_search.kind, "tool");
  assert.equal(byId.scrape.kind, "tool");
});
