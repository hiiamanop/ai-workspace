import { test } from "node:test";
import assert from "node:assert/strict";
import { availableCandidates, availableToolCandidates } from "../src/candidates.ts";

test("availableCandidates() throws when OmniRouter is not configured", () => {
  assert.throws(() => availableCandidates({}), /OMNIROUTER_API_KEY not set/);
});

test("availableCandidates() returns curated Antigravity models and explicit fallbacks", () => {
  const candidates = availableCandidates({ OMNIROUTER_API_KEY: "sk-test" });
  assert.equal(candidates.every((c) => c.vendor === "omnirouter" && c.kind === "model"), true);
  assert.deepEqual(candidates.slice(-1).map((c) => c.id), ["openrouter/minimax/minimax-m3:free"]);
  assert.equal(new Set(candidates.map((c) => c.id)).size, candidates.length);
  assert.equal(candidates.every((c) => c.verified && c.capabilities?.streaming && c.capabilities.tool_calling), true);
});

test("availableToolCandidates() returns web_search and scrape as tool-kind candidates", () => {
  const candidates = availableToolCandidates();
  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));

  assert.equal(byId.web_search.kind, "tool");
  assert.equal(byId.scrape.kind, "tool");
});

test("availableCandidates() preserves verified context windows", () => {
  const candidates = availableCandidates({ OMNIROUTER_API_KEY: "sk-test" });
  const gemini = candidates.find((c) => c.id === "antigravity/gemini-2.5-flash");
  const minimax = candidates.find((c) => c.id === "openrouter/minimax/minimax-m3:free");
  assert.equal(gemini?.context_window_tokens, 1_048_576);
  assert.equal(minimax?.context_window_tokens, 1_048_576);
});
