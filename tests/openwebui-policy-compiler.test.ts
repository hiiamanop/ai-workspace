import assert from "node:assert/strict";
import { test } from "node:test";
import { CompileError, COMPILE_SYSTEM_PROMPT, compilePolicy } from "../src/openwebui-policy-compiler.ts";
import type { ChatMessage, CompletionResult } from "../src/types.ts";

const VALID_REGO = [
  "package made.hard",
  "import future.keywords",
  "",
  'deny[msg] {',
  "  input.candidate.cost_per_1k_tokens > 0.10",
  '  msg := "Melebihi batas biaya"',
  "}",
].join("\n");

function stubComplete(result: string) {
  const calls: Array<{ model: string; messages: ChatMessage[] }> = [];
  const complete = async (model: string, messages: ChatMessage[]): Promise<CompletionResult> => {
    calls.push({ model, messages });
    return { content: result, toolCalls: [] };
  };
  return { complete, calls };
}

test("sends the markdown to deepseek-v4-flash with the compile system prompt and returns the rego", async () => {
  const { complete, calls } = stubComplete(`Here is the policy:\n\n\`\`\`rego\n${VALID_REGO}\n\`\`\``);
  const markdown = "IF candidate.cost_per_1k_tokens > 0.10 THEN deny over budget";

  const out = await compilePolicy(markdown, { complete });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "deepseek-v4-flash");
  assert.ok(calls[0].messages[0].content.includes("package made.hard"));
  assert.equal(calls[0].messages[1].content, markdown);
  assert.equal(out.rego, VALID_REGO);
  assert.deepEqual(out.warnings, []);
});

test("tolerates markdown fences the model adds around the rego", async () => {
  const { complete } = stubComplete(`\`\`\`\n${VALID_REGO}\n\`\`\``);
  const out = await compilePolicy("some policy", { complete });
  assert.equal(out.rego, VALID_REGO);
});

test("rejects empty markdown without calling the model", async () => {
  let called = false;
  const complete = async (): Promise<CompletionResult> => {
    called = true;
    return { content: "", toolCalls: [] };
  };
  await assert.rejects(() => compilePolicy("   ", { complete }), CompileError);
  assert.equal(called, false);
});

test("throws CompileError when the model refuses with UNABLE_TO_COMPILE", async () => {
  const { complete } = stubComplete("UNABLE_TO_COMPILE: no budget threshold was given");
  await assert.rejects(
    () => compilePolicy("Cap spending somehow", { complete }),
    /too vague.*budget threshold/
  );
});

test("throws CompileError when the model output is missing package made.hard", async () => {
  const { complete } = stubComplete('deny[msg] {\n  input.candidate.cost_per_1k_tokens > 0.10\n  msg := "x"\n}');
  await assert.rejects(() => compilePolicy("whatever", { complete }), /missing 'package made\.hard'/);
});

test("throws CompileError when the model output defines default allow", async () => {
  const { complete } = stubComplete('package made.hard\n\ndefault allow = true\ndeny[msg] { msg := "x" }');
  await assert.rejects(() => compilePolicy("whatever", { complete }), /default allow/);
});

test("warns when the compiled policy defines no deny[] rules", async () => {
  const { complete } = stubComplete("package made.hard\n\nallow { true }");
  const out = await compilePolicy("a policy that allows everything", { complete });
  assert.equal(out.rego, "package made.hard\nimport future.keywords\n\nallow { true }");
  assert.match(out.warnings.join(" "), /no deny\[\]/);
});

test("injects import future.keywords so rego using the in operator parses under MADE's OPA v0.67", async () => {
  const { complete } = stubComplete(
    'package made.hard\n\ndeny[msg] {\n  input.task.data_classification in ["confidential", "restricted"]\n  msg := "no confidential leaks"\n}'
  );
  const out = await compilePolicy("deny confidential or restricted data", { complete });
  assert.ok(out.rego.startsWith("package made.hard\nimport future.keywords\n"));
  assert.ok(out.rego.includes('in ["confidential", "restricted"]'));
});
