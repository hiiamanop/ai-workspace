import assert from "node:assert/strict";
import { test } from "node:test";
import { CompileError, compilePolicy } from "../src/openwebui-policy-compiler.ts";

test("compiles a single comparison rule to a deny[] block under package made.hard", async () => {
  const markdown = ['IF candidate.cost_per_1k_tokens > 0.10', 'THEN deny "Melebihi batas biaya"'].join("\n");
  const out = await compilePolicy(markdown);

  assert.equal(
    out.rego,
    [
      "package made.hard",
      "",
      'deny[msg] {\n  input.candidate.cost_per_1k_tokens > 0.10\n  msg := "Melebihi batas biaya"\n}',
    ].join("\n\n")
  );
  assert.deepEqual(out.warnings, []);
});

test("compiles multiple AND-joined conditions, including a bare boolean and a NOT-prefixed one, into one deny block", async () => {
  const markdown = [
    "IF candidate.vendor == \"deepseek\"",
    'AND task.data_classification IN ["confidential", "restricted"]',
    "AND NOT task.redacted",
    'THEN deny "DeepSeek tidak boleh untuk data confidential tanpa redaksi"',
  ].join("\n");

  const out = await compilePolicy(markdown);

  assert.equal(
    out.rego,
    [
      "package made.hard",
      "",
      [
        "deny[msg] {",
        '  input.candidate.vendor == "deepseek"',
        '  {"confidential","restricted"}[input.task.data_classification]',
        "  not input.task.redacted",
        '  msg := "DeepSeek tidak boleh untuk data confidential tanpa redaksi"',
        "}",
      ].join("\n"),
    ].join("\n\n")
  );
});

test("compiles multiple rule blocks into multiple deny[] blocks, ignoring headings/prose in between", async () => {
  const markdown = [
    "# Budget Limit Policy",
    "",
    "This policy caps candidate cost.",
    "",
    "IF candidate.cost_per_1k_tokens > 0.10",
    'THEN deny "Over budget"',
    "",
    "## Second rule",
    "",
    "IF org.region == \"EU\"",
    'THEN deny "EU region blocked"',
  ].join("\n");

  const out = await compilePolicy(markdown);
  const denyBlocks = out.rego.match(/deny\[msg\]/g);
  assert.equal(denyBlocks?.length, 2);
  assert.match(out.rego, /input\.candidate\.cost_per_1k_tokens > 0\.10/);
  assert.match(out.rego, /input\.org\.region == "EU"/);
});

test("bare field with no operator compiles to a truthy check", async () => {
  const markdown = ["IF task.redacted", 'THEN deny "should never trigger without redaction check inverted"'].join(
    "\n"
  );
  const out = await compilePolicy(markdown);
  assert.match(out.rego, /^\s*input\.task\.redacted\s*$/m);
});

test("rejects empty markdown", async () => {
  await assert.rejects(() => compilePolicy("   "), CompileError);
});

test("rejects a policy with no IF/THEN rules", async () => {
  await assert.rejects(() => compilePolicy("# Just a heading\n\nSome prose, no rules."), CompileError);
});

test("rejects an IF block never closed with THEN deny", async () => {
  await assert.rejects(
    () => compilePolicy('IF candidate.vendor == "deepseek"\nAND task.redacted'),
    /never closed/
  );
});

test("rejects THEN deny with an empty message", async () => {
  await assert.rejects(() => compilePolicy('IF task.redacted\nTHEN deny ""'), /non-empty message/);
});

test("rejects an unrecognized line inside a rule block", async () => {
  await assert.rejects(
    () => compilePolicy('IF task.redacted\nMAYBE deny "nope"'),
    /expected "AND/
  );
});

test("rejects an unknown field name (typo protection)", async () => {
  await assert.rejects(() => compilePolicy('IF taks.vendor == "deepseek"\nTHEN deny "x"'), /unknown field/);
});

test("rejects an invalid scalar value (not quoted string / number / bool)", async () => {
  await assert.rejects(
    () => compilePolicy("IF candidate.vendor == deepseek\nTHEN deny \"x\""),
    /invalid value/
  );
});

test("rejects an IN list that isn't valid JSON", async () => {
  await assert.rejects(
    () => compilePolicy("IF task.data_classification IN [confidential]\nTHEN deny \"x\""),
    CompileError
  );
});

test("rejects an unparseable condition line", async () => {
  await assert.rejects(() => compilePolicy('IF ???\nTHEN deny "x"'), /could not parse condition/);
});
