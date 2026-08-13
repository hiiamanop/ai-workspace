import { complete as deepseekComplete } from "./providers/deepseek-client.ts";
import type { ChatMessage, CompletionResult } from "./types.ts";

// Compile an admin-authored Markdown policy into OPA Rego for MADE.
// MADE evaluates hard constraints via `opa eval --data <policies_dir> data.made.hard`,
// so compiled output MUST use `package made.hard` — any other package silently
// never runs (the exact class of bug the B' review caught).
// MADE ships policies/hard/base.rego which OWNS `default allow`; compiled
// policies MUST only add deny[reason] rules — a second `default allow` breaks
// the whole hard-constraint engine (opa: multiple default rules for
// data.made.hard.allow), which is what the C1 task review caught.

export class CompileError extends Error {}

export const COMPILE_SYSTEM_PROMPT = `You are a Rego/OPA expert. Compile the following policy description to OPA Rego code for MADE's hard-constraint policy engine.

Requirements:
- The Rego MUST declare "package made.hard" as its first line.
- Emit ONLY deny[reason] rules for every constraint violation — do NOT define
  "allow" in any form (MADE's base.rego owns "default allow"; a second default
  breaks the whole policy set).
- The evaluation input has this shape:
  input.decision_kind ("model_selection" | "tool_selection" | "human_approval")
  input.task.type, input.task.data_classification, input.task.estimated_context_tokens
  input.org.budget_remaining_usd, input.org.region
  input.candidate.id, input.candidate.vendor, input.candidate.cost_per_1k_tokens, input.candidate.scores
- If the policy description is too vague to express concrete constraints, reply with exactly: UNABLE_TO_COMPILE: <one sentence explaining what is missing>
- Output ONLY the Rego code. No explanation, no markdown fences.`;

const COMPILE_MODEL = "deepseek-v4-flash";

interface CompilerDeps {
  complete: (model: string, messages: ChatMessage[]) => Promise<CompletionResult>;
}

export async function compilePolicy(
  markdown: string,
  deps: CompilerDeps = { complete: deepseekComplete }
): Promise<{ rego: string; warnings?: string[] }> {
  if (!markdown || markdown.trim() === "") {
    throw new CompileError("Markdown policy is empty");
  }

  const messages: ChatMessage[] = [
    { role: "system", content: COMPILE_SYSTEM_PROMPT },
    { role: "user", content: markdown },
  ];

  const result = await deps.complete(COMPILE_MODEL, messages);
  const raw = (result.content ?? "").trim();

  if (raw.startsWith("UNABLE_TO_COMPILE:")) {
    throw new CompileError(`Markdown is too vague for compilation: ${raw.slice("UNABLE_TO_COMPILE:".length).trim()}`);
  }

  const rego = extractRego(raw);
  if (!rego.includes("package made.hard")) {
    throw new CompileError("LLM output is not valid Rego for MADE: missing 'package made.hard'");
  }
  // base.rego owns `default allow`; a compiled default would break every
  // /decide call (opa: multiple default rules for data.made.hard.allow).
  if (/\bdefault\s+allow\b/.test(rego)) {
    throw new CompileError("LLM output defines 'default allow' — MADE's base.rego owns it; emit only deny[reason] rules");
  }

  const warnings: string[] = [];
  if (!rego.includes("deny[")) {
    warnings.push("Compiled policy defines no deny[] rules — it will not block anything");
  }

  return { rego, warnings };
}

function extractRego(raw: string): string {
  // Tolerate markdown fences the model adds despite instructions
  const fenced = raw.match(/```(?:rego)?\s*\n([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : raw.trim();
}
