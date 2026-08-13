import assert from "node:assert/strict";
import { test } from "node:test";
import { CompileError, compilePolicy } from "../src/openwebui-policy-compiler.ts";
import type { ChatMessage, CompletionResult } from "../src/types.ts";

const MARKDOWN = "Enforce cost limit of $0.10 per request.";
// Deny-only: MADE's base.rego owns `default allow` — a second default
// breaks every /decide call (C1 review's blocking finding).
const GOOD_REGO = [
  "package made.hard",
  'deny[msg] { input.candidate.cost_per_1k_tokens > 0.1 }',
].join("\n");

function stubComplete(result: string) {
  const calls: Array<{ model: string; messages: ChatMessage[] }> = [];
  const complete = async (model: string, messages: ChatMessage[]): Promise<CompletionResult> => {
    calls.push({ model, messages });
    return { content: result, toolCalls: [] };
  };
  return { complete, calls };
}

test("compiles markdown to rego with the flash model and MADE package", async () => {
  const { complete, calls } = stubComplete(GOOD_REGO);
  const out = await compilePolicy(MARKDOWN, { complete });

  assert.equal(out.rego, GOOD_REGO);
  assert.deepEqual(out.warnings, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "deepseek-v4-flash");
  assert.ok(calls[0].messages[0].content.includes("package made.hard")); // system prompt
  assert.equal(calls[0].messages[1].content, MARKDOWN);
});

test("strips rego code fences the model adds anyway", async () => {
  const { complete } = stubComplete("```rego\n" + GOOD_REGO + "\n```");
  const out = await compilePolicy(MARKDOWN, { complete });
  assert.equal(out.rego, GOOD_REGO);
});

test("warns when the compiled policy has no deny[] rules", async () => {
  const { complete } = stubComplete("package made.hard\nx := 1");
  const out = await compilePolicy(MARKDOWN, { complete });
  assert.ok(out.warnings!.length > 0);
  assert.match(out.warnings![0], /deny/);
});

test("rejects output defining default allow (base.rego owns it; would break MADE)", async () => {
  const { complete } = stubComplete("package made.hard\ndefault allow = true\ndeny[msg] { true }");
  await assert.rejects(() => compilePolicy(MARKDOWN, { complete }), CompileError);
});

test("rejects empty markdown", async () => {
  await assert.rejects(() => compilePolicy("   ", { complete: stubComplete(GOOD_REGO).complete }), CompileError);
});

test("rejects UNABLE_TO_COMPILE output from the model", async () => {
  const { complete } = stubComplete("UNABLE_TO_COMPILE: policy does not say which candidate field to limit");
  await assert.rejects(() => compilePolicy(MARKDOWN, { complete }), CompileError);
});

test("rejects output missing package made.hard (would silently never run in MADE)", async () => {
  const { complete } = stubComplete('package hard_constraints\ndefault allow = true\ndeny[msg] { true }');
  await assert.rejects(() => compilePolicy(MARKDOWN, { complete }), CompileError);
});
