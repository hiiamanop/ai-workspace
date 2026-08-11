import { test } from "node:test";
import assert from "node:assert/strict";
import { trimHistory } from "../src/history-budget.ts";
import { estimateContextTokens } from "../src/token-estimate.ts";
import type { ChatMessage } from "../src/types.ts";

test("trimHistory() returns history unchanged when it fits the budget", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const result = trimHistory(messages, 100_000);
  assert.deepEqual(result, messages);
});

test("trimHistory() drops the oldest whole messages until the remainder fits", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "x".repeat(4000) },
    { role: "assistant", content: "y".repeat(4000) },
    { role: "user", content: "recent question" },
  ];
  const budget = estimateContextTokens("", [], [messages[2]]) + 10;
  const result = trimHistory(messages, budget);

  assert.deepEqual(result, [messages[2]]);
});

test("trimHistory() keeps a single already-over-budget message rather than returning nothing", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(50_000) }];
  const result = trimHistory(messages, 10);
  assert.deepEqual(result, messages);
});

test("trimHistory() keeps the most recent messages when trimming, not the oldest", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "x".repeat(3000) },
    { role: "user", content: "second" },
    { role: "assistant", content: "y".repeat(3000) },
    { role: "user", content: "third, most recent" },
  ];
  const budget = estimateContextTokens("", [], messages.slice(-1)) + 10;
  const result = trimHistory(messages, budget);

  assert.deepEqual(result, [messages[4]]);
});
