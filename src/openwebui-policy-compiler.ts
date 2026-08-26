// Compile an admin-authored Markdown policy into OPA Rego for MADE.
// MADE evaluates hard constraints via `opa eval --data <policies_dir> data.made.hard`,
// so compiled output MUST use `package made.hard` — any other package silently
// never runs. MADE ships policies/hard/base.rego which OWNS `default allow`;
// compiled policies MUST only add deny[reason] rules — a second `default
// allow` breaks the whole hard-constraint engine (opa: multiple default
// rules for data.made.hard.allow).
//
// Deterministic, no LLM: the Markdown must contain one or more fixed-syntax
// rule blocks —
//
//   IF <condition>
//   [AND <condition>]...
//   THEN deny "<message>"
//
// — everything else in the file (headings, prose, blank lines) is treated
// as documentation and ignored. A condition is either a bare boolean field
// reference (`task.redacted`) or `<field> <op> <value>` with op one of
// `== != > < >= <= IN`; either form may be prefixed with `NOT`. This trades
// the LLM compiler's flexibility (any prose) for zero hallucination risk —
// a well-formed policy compiles the same way every time, and a malformed
// one fails with a line-numbered syntax error instead of silently-wrong
// Rego. See policy-drafter.ts for the chat assistant that now drafts in
// this exact syntax.

export class CompileError extends Error {}

const FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
const KNOWN_PREFIXES = ["task.", "candidate.", "org."];
const KNOWN_EXACT = ["decision_kind"];

const IF_RE = /^\s*IF\s+(.+)$/i;
const AND_RE = /^\s*AND\s+(.+)$/i;
const THEN_RE = /^\s*THEN\s+deny\s+"([^"]*)"\s*$/i;
const CONDITION_WITH_OP_RE =
  /^(NOT\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)\s+(==|!=|>=|<=|>|<|IN)\s+(.+)$/i;
const CONDITION_BARE_RE = /^(NOT\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)\s*$/i;

interface ParsedRule {
  clauses: string[];
  message: string;
}

export async function compilePolicy(markdown: string): Promise<{ rego: string; warnings: string[] }> {
  if (!markdown || markdown.trim() === "") {
    throw new CompileError("Markdown policy is empty");
  }

  const lines = markdown.split(/\r?\n/);
  const rules: ParsedRule[] = [];

  let current: ParsedRule | null = null;
  let blockStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];

    if (current === null) {
      const ifMatch = line.match(IF_RE);
      if (ifMatch) {
        current = { clauses: [compileCondition(ifMatch[1], lineNo)], message: "" };
        blockStartLine = lineNo;
      }
      // Anything else outside a block (headings, prose, blank lines) is documentation.
      continue;
    }

    if (line.trim() === "") continue; // blank lines inside a block are just formatting

    const andMatch = line.match(AND_RE);
    if (andMatch) {
      current.clauses.push(compileCondition(andMatch[1], lineNo));
      continue;
    }

    const thenMatch = line.match(THEN_RE);
    if (thenMatch) {
      const message = thenMatch[1].trim();
      if (!message) {
        throw new CompileError(`Line ${lineNo}: "THEN deny" requires a non-empty message in quotes`);
      }
      current.message = message;
      rules.push(current);
      current = null;
      continue;
    }

    throw new CompileError(
      `Line ${lineNo}: expected "AND <condition>" or "THEN deny \"<message>\"", got: ${line.trim() || "(blank)"}`
    );
  }

  if (current !== null) {
    throw new CompileError(
      `Line ${blockStartLine}: "IF" block was never closed with a "THEN deny \"<message>\"" line`
    );
  }

  if (rules.length === 0) {
    throw new CompileError(
      'No IF/THEN rules found. Expected syntax:\nIF <field> <op> <value>\nTHEN deny "<message>"'
    );
  }

  const rego = [
    "package made.hard",
    "",
    ...rules.map(
      (rule) =>
        `deny[msg] {\n${rule.clauses.map((c) => `  ${c}`).join("\n")}\n  msg := ${JSON.stringify(rule.message)}\n}`
    ),
  ].join("\n\n");

  return { rego, warnings: [] };
}

function compileCondition(raw: string, lineNo: number): string {
  const text = raw.trim();

  const withOp = text.match(CONDITION_WITH_OP_RE);
  if (withOp) {
    const [, notPrefix, field, op, rawValue] = withOp;
    validateField(field, lineNo);
    const opUpper = op.toUpperCase();
    const clause =
      opUpper === "IN"
        ? `${compileInSet(rawValue, lineNo)}[input.${field}]`
        : `input.${field} ${op} ${compileScalarValue(rawValue, lineNo)}`;
    return notPrefix ? `not ${clause}` : clause;
  }

  const bare = text.match(CONDITION_BARE_RE);
  if (bare) {
    const [, notPrefix, field] = bare;
    validateField(field, lineNo);
    return notPrefix ? `not input.${field}` : `input.${field}`;
  }

  throw new CompileError(
    `Line ${lineNo}: could not parse condition "${text}". Expected "<field>", "NOT <field>", or "<field> <op> <value>" (op one of == != > < >= <= IN)`
  );
}

function validateField(field: string, lineNo: number): void {
  if (!FIELD_RE.test(field)) {
    throw new CompileError(`Line ${lineNo}: invalid field name "${field}"`);
  }
  const known = KNOWN_EXACT.includes(field) || KNOWN_PREFIXES.some((p) => field.startsWith(p));
  if (!known) {
    throw new CompileError(
      `Line ${lineNo}: unknown field "${field}" — expected "decision_kind" or one of task.*, candidate.*, org.*`
    );
  }
}

function compileScalarValue(raw: string, lineNo: number): string {
  const text = raw.trim();
  if (/^"[^"]*"$/.test(text)) return text; // quoted string literal, keep as-is
  if (/^-?\d+(\.\d+)?$/.test(text)) return text; // number
  if (/^(true|false)$/.test(text)) return text; // boolean
  throw new CompileError(
    `Line ${lineNo}: invalid value "${text}" — expected a quoted string, a number, true/false, or IN [...]`
  );
}

function compileInSet(raw: string, lineNo: number): string {
  const text = raw.trim();
  const bracketed = text.match(/^\[(.*)\]$/);
  if (!bracketed) {
    throw new CompileError(`Line ${lineNo}: IN requires a bracketed list, e.g. IN ["a", "b"], got: ${text}`);
  }
  let values: unknown;
  try {
    values = JSON.parse(text);
  } catch {
    throw new CompileError(`Line ${lineNo}: could not parse IN list "${text}" as JSON (use double-quoted strings)`);
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new CompileError(`Line ${lineNo}: IN list must be a non-empty array`);
  }
  for (const v of values) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new CompileError(`Line ${lineNo}: IN list values must be strings, numbers, or booleans`);
    }
  }
  return `{${values.map((v) => JSON.stringify(v)).join(",")}}`;
}
