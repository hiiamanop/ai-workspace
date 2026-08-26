import { complete as deepseekComplete } from "./providers/deepseek-client.ts";
import { compilePolicy, CompileError } from "./openwebui-policy-compiler.ts";
import type { ChatMessage, CompletionResult } from "./types.ts";

// Conversational counterpart to openwebui-policy-compiler.ts: that module
// deterministically compiles the fixed IF/THEN Markdown syntax to Rego (no
// LLM — see its own header comment for why), this one helps an admin
// *arrive* at Markdown in that exact syntax by chatting (and optionally
// pasting a regulation document's extracted text as a message). The LLM is
// only ever used to help write the Markdown a human then reviews — never to
// interpret or generate Rego, so a hallucinated rule fails deterministic
// compilation rather than silently reaching MADE.

const DRAFT_MODEL = "deepseek-v4-flash";

// Keep the grammar description below byte-for-byte consistent with
// openwebui-policy-compiler.ts's actual parser (IF_RE/AND_RE/THEN_RE/
// CONDITION_*_RE) — this prompt's only job is to make the model emit text
// that parser accepts.
export const DRAFT_SYSTEM_PROMPT = `You are a policy analyst helping an admin draft a Markdown policy for MADE, an AI-routing decision engine. The Markdown you draft gets compiled by a deterministic parser (no LLM involved in that step) into OPA Rego "deny" rules, so every rule MUST use this exact fixed syntax — free-form prose rules will fail to compile:

IF <condition>
[AND <condition>]...
THEN deny "<message>"

A <condition> is one of:
  <field>                     (bare field = true-check, e.g. "task.redacted")
  NOT <field>                 (negated true-check)
  <field> <op> <value>        (op is one of == != > < >= <=)
  NOT <field> <op> <value>
  <field> IN [<value>, ...]   (set membership, e.g. task.data_classification IN ["confidential", "restricted"])
  NOT <field> IN [<value>, ...]

Values are double-quoted strings, numbers, or true/false — no unquoted bare words.
Fields must be one of: decision_kind, or start with task., candidate., org. — specifically:
  decision_kind ("model_selection" | "tool_selection" | "human_approval")
  task.type, task.data_classification, task.estimated_context_tokens, task.redacted (bool, true when PII/entities were pseudonymized before this request)
  org.budget_remaining_usd, org.region
  candidate.id, candidate.vendor, candidate.cost_per_1k_tokens

You may write multiple IF/THEN blocks in one policy. Anything outside a block (headings, prose paragraphs, blank lines) is ignored by the compiler — use it freely for human-readable context, but every actual rule must follow the syntax above exactly.

The admin may paste the text of an existing regulation or internal policy document — treat that as source material to translate into this syntax, not as the final answer.

Converse naturally. Ask clarifying questions when the request is too vague to express as a concrete constraint (e.g. missing a threshold, an unclear scope, an ambiguous data classification, or a field not in the list above). Once you have enough to draft the policy, reply with a short summary of what it does, then end your message with the full draft in a fenced code block labeled "markdown":

\`\`\`markdown
# Policy Name

IF candidate.vendor == "deepseek"
AND task.data_classification IN ["confidential", "restricted"]
AND NOT task.redacted
THEN deny "DeepSeek is not approved for unredacted confidential data"
\`\`\`

Only include that fenced block when the draft is ready — do not include a partial or placeholder draft while still asking questions. If you are told a previous draft failed to compile, read the syntax error and fix the exact line it points to.`;

interface DrafterDeps {
  complete: (model: string, messages: ChatMessage[]) => Promise<CompletionResult>;
}

export async function draftPolicy(
  messages: ChatMessage[],
  deps: DrafterDeps = { complete: deepseekComplete }
): Promise<{ content: string; draftMarkdown: string | null }> {
  if (!messages || messages.length === 0) {
    throw new Error("At least one message is required");
  }

  const result = await deps.complete(DRAFT_MODEL, [
    { role: "system", content: DRAFT_SYSTEM_PROMPT },
    ...messages,
  ]);
  const content = (result.content ?? "").trim();
  const candidate = extractMarkdownDraft(content);

  if (candidate === null) {
    return { content, draftMarkdown: null };
  }

  // The deterministic compiler is cheap (no LLM) — validate the draft right
  // here so "draftMarkdown" only ever means "will actually compile", not
  // "the model believes it's done". A syntax error gets surfaced in the
  // chat transcript so the next turn can ask the model to fix that exact line.
  try {
    await compilePolicy(candidate);
    return { content, draftMarkdown: candidate };
  } catch (err) {
    const reason = err instanceof CompileError ? err.message : (err as Error).message;
    return {
      content: `${content}\n\n⚠️ This draft doesn't compile yet: ${reason}`,
      draftMarkdown: null,
    };
  }
}

function extractMarkdownDraft(content: string): string | null {
  const fenced = content.match(/```markdown\s*\n([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : null;
}
