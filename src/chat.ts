import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates, availableToolCandidates as defaultAvailableToolCandidates } from "./candidates.ts";
import { complete as ollamaComplete } from "./providers/ollama-client.ts";
import { complete as deepseekComplete } from "./providers/deepseek-client.ts";
import { callWebSearch } from "./mcp/searxng-client.ts";
import { callScrape } from "./mcp/scrapling-client.ts";
import { TOOL_DEFS } from "./tools.ts";
import type { CandidateIn, ChatMessage, CompletionResult, DecideRequest, DecideResponse, ToolDef } from "./types.ts";

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 8000;

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

export interface ChatDeps {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  availableCandidates: () => CandidateIn[];
  availableToolCandidates: () => CandidateIn[];
  completeByProvider: Record<string, (model: string, messages: ChatMessage[], tools: ToolDef[]) => Promise<CompletionResult>>;
  toolExecutors: Record<string, ToolExecutor>;
}

const defaultDeps: ChatDeps = {
  decide: defaultDecide,
  availableCandidates: defaultAvailableCandidates,
  availableToolCandidates: defaultAvailableToolCandidates,
  completeByProvider: {
    "ollama-local": ollamaComplete,
    deepseek: deepseekComplete,
  },
  toolExecutors: {
    web_search: (args) => callWebSearch(String(args.query)),
    scrape: (args) => callScrape(String(args.url)),
  },
};

function decideRequest(decisionKind: DecideRequest["decision_kind"], candidates: CandidateIn[]): DecideRequest {
  return {
    task: { type: "chat", data_classification: "internal" },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: decisionKind,
    candidates,
    policy_set: "default",
  };
}

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) {
    return result;
  }
  let cut = MAX_TOOL_RESULT_CHARS;
  const code = result.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    cut -= 1;
  }
  return `${result.slice(0, cut)}...[truncated, ${result.length} chars total]`;
}

export async function handleChat(
  message: string,
  deps: ChatDeps = defaultDeps
): Promise<{ selectedCandidateId: string; reply: string; toolsUsed: string[] }> {
  const candidates = deps.availableCandidates();

  const modelDecision = await deps.decide(decideRequest("model_selection", candidates));

  if (!modelDecision.selected_candidate_id) {
    throw new Error("MADE returned no eligible candidate");
  }
  if (modelDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }

  const selected = candidates.find((c) => c.id === modelDecision.selected_candidate_id);
  if (!selected) {
    throw new Error(`MADE selected unknown candidate id ${modelDecision.selected_candidate_id}`);
  }

  const complete = deps.completeByProvider[selected.vendor];
  if (!complete) {
    throw new Error(`no provider client registered for vendor ${selected.vendor}`);
  }

  const toolCandidates = deps.availableToolCandidates();
  const toolDecision = await deps.decide(decideRequest("tool_selection", toolCandidates));
  if (toolDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }
  const allowedToolIds = new Set(toolDecision.ranking.map((r) => r.id));
  const tools: ToolDef[] = toolCandidates
    .filter((c) => allowedToolIds.has(c.id))
    .map((c) => TOOL_DEFS[c.id])
    .filter((t): t is ToolDef => Boolean(t));

  const messages: ChatMessage[] = [{ role: "user", content: message }];
  const toolsUsed: string[] = [];
  let lastNonEmptyContent: string | null = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await complete(selected.id, messages, tools);

    if (result.content) {
      lastNonEmptyContent = result.content;
    }

    if (result.toolCalls.length === 0) {
      return { selectedCandidateId: selected.id, reply: result.content ?? "", toolsUsed };
    }

    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      const executor = deps.toolExecutors[call.function.name];
      let toolResult: string;
      if (!executor) {
        toolResult = `tool ${call.function.name} is not available`;
      } else {
        try {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          toolResult = await executor(args);
          toolsUsed.push(call.function.name);
        } catch (err) {
          toolResult = `${call.function.name} failed: ${(err as Error).message}`;
        }
      }
      messages.push({ role: "tool", content: truncateToolResult(toolResult), tool_call_id: call.id, name: call.function.name });
    }
  }

  if (lastNonEmptyContent) {
    return {
      selectedCandidateId: selected.id,
      reply: `${lastNonEmptyContent}\n\n[tool loop limit reached — response may be incomplete]`,
      toolsUsed,
    };
  }

  throw new Error("tool-calling loop exceeded maximum iterations");
}
