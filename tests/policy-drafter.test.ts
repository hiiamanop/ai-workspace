import assert from "node:assert/strict";
import { test } from "node:test";
import { draftPolicy } from "../src/policy-drafter.ts";
import type { ChatMessage, CompletionResult } from "../src/types.ts";

function stubComplete(result: string) {
  const calls: Array<{ model: string; messages: ChatMessage[] }> = [];
  const complete = async (model: string, messages: ChatMessage[]): Promise<CompletionResult> => {
    calls.push({ model, messages });
    return { content: result, toolCalls: [] };
  };
  return { complete, calls };
}

const VALID_DRAFT_REPLY = [
  "Here's a draft that caps DeepSeek spend:",
  "",
  "```markdown",
  "# Budget Limit Policy",
  "",
  "IF candidate.vendor == \"deepseek\"",
  "AND candidate.cost_per_1k_tokens > 0.10",
  'THEN deny "DeepSeek over budget"',
  "```",
].join("\n");

test("sends system prompt + conversation to the flash model", async () => {
  const { complete, calls } = stubComplete("What data classification should this apply to?");
  const messages: ChatMessage[] = [{ role: "user", content: "Limit DeepSeek spend to $0.10/request" }];

  const out = await draftPolicy(messages, { complete });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "deepseek-v4-flash");
  assert.ok(calls[0].messages[0].content.includes("MADE"));
  assert.deepEqual(calls[0].messages.slice(1), messages);
  assert.equal(out.content, "What data classification should this apply to?");
  assert.equal(out.draftMarkdown, null);
});

test("extracts and validates the fenced markdown draft when it compiles cleanly", async () => {
  const { complete } = stubComplete(VALID_DRAFT_REPLY);

  const out = await draftPolicy([{ role: "user", content: "Limit DeepSeek spend to $0.10/request" }], { complete });

  assert.equal(
    out.draftMarkdown,
    '# Budget Limit Policy\n\nIF candidate.vendor == "deepseek"\nAND candidate.cost_per_1k_tokens > 0.10\nTHEN deny "DeepSeek over budget"'
  );
  assert.equal(out.content, VALID_DRAFT_REPLY);
});

test("returns null draftMarkdown for a clarifying question with no fence", async () => {
  const { complete } = stubComplete("Which vendor should this apply to?");
  const out = await draftPolicy([{ role: "user", content: "Add a spend cap" }], { complete });
  assert.equal(out.draftMarkdown, null);
});

test("a fenced draft that fails deterministic compilation is not treated as ready, and the error is surfaced", async () => {
  const reply = ["Here's the policy:", "", "```markdown", "# Policy", "Deny DeepSeek over budget somehow.", "```"].join(
    "\n"
  );
  const { complete } = stubComplete(reply);

  const out = await draftPolicy([{ role: "user", content: "Cap DeepSeek spend" }], { complete });

  assert.equal(out.draftMarkdown, null);
  assert.match(out.content, /doesn't compile yet/);
  assert.match(out.content, /No IF\/THEN rules found/);
});

test("rejects an empty message list", async () => {
  await assert.rejects(() => draftPolicy([], { complete: stubComplete("x").complete }));
});
