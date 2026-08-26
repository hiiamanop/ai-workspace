import assert from "node:assert/strict";
import { test } from "node:test";
import { draftPolicy } from "../src/policy-drafter.ts";
import type { ChatMessage, CompletionResult } from "../src/types.ts";

// The drafter makes up to two LLM calls per turn: one to draft (returns
// `draftReply`), and, when the draft has a fenced markdown block, a second one
// to validate it via compilePolicy (returns `validationReply`). The stub is
// call-count based so tests can give each call different output.
function stubComplete(draftReply: string, validationReply?: string) {
  const calls: Array<{ model: string; messages: ChatMessage[] }> = [];
  let n = 0;
  const complete = async (model: string, messages: ChatMessage[]): Promise<CompletionResult> => {
    calls.push({ model, messages });
    n += 1;
    return { content: n === 1 ? draftReply : (validationReply ?? draftReply), toolCalls: [] };
  };
  return { complete, calls };
}

const VALID_REGO = [
  "package made.hard",
  "",
  'deny[msg] {',
  '  input.candidate.vendor == "deepseek"',
  "  not input.task.redacted",
  '  msg := "DeepSeek over budget"',
  "}",
].join("\n");

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
  const { complete } = stubComplete(VALID_DRAFT_REPLY, VALID_REGO);

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

test("a fenced draft that fails LLM compilation is not treated as ready, and the error is surfaced", async () => {
  const reply = ["Here's the policy:", "", "```markdown", "# Policy", "Deny DeepSeek over budget somehow.", "```"].join(
    "\n"
  );
  const { complete } = stubComplete(reply, "This is not valid Rego.");

  const out = await draftPolicy([{ role: "user", content: "Cap DeepSeek spend" }], { complete });

  assert.equal(out.draftMarkdown, null);
  assert.match(out.content, /doesn't compile yet/);
  assert.match(out.content, /package made\.hard/);
});

test("rejects an empty message list", async () => {
  await assert.rejects(() => draftPolicy([], { complete: stubComplete("x").complete }));
});
