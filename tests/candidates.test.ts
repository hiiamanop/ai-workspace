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

test("availableCandidates() sets the Ollama candidate's context_window_tokens from OLLAMA_CONTEXT_WINDOW, defaulting to 4096", () => {
  const withDefault = availableCandidates({});
  const ollamaDefault = withDefault.find((c) => c.id === "gemma4:12b");
  assert.equal(ollamaDefault?.context_window_tokens, 4096);

  const withOverride = availableCandidates({ OLLAMA_CONTEXT_WINDOW: "16384" });
  const ollamaOverride = withOverride.find((c) => c.id === "gemma4:12b");
  assert.equal(ollamaOverride?.context_window_tokens, 16384);
});

test("availableCandidates() sets the DeepSeek candidate's context_window_tokens to 1,000,000", () => {
  const candidates = availableCandidates({ DEEPSEEK_API_KEY: "sk-test" });
  const deepseek = candidates.find((c) => c.id === "deepseek-v4-flash");
  assert.equal(deepseek?.context_window_tokens, 1_000_000);
});
