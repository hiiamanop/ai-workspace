import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates, availableToolCandidates as defaultAvailableToolCandidates } from "./candidates.ts";
import { complete as omniRouterComplete, completeStream as omniRouterCompleteStream } from "./providers/openai-compatible-client.ts";
import { callWebSearch, type WebSearchResponse, type WebSearchResult } from "./mcp/searxng-client.ts";
import { formatWebSearchResults } from "./web-search-format.ts";
import { callScrape } from "./mcp/scrapling-client.ts";
import { TOOL_DEFS } from "./tools.ts";
import { estimateContextTokens } from "./token-estimate.ts";
import { ensureCandidateFits } from "./context-guard.ts";
import { trimHistory } from "./history-budget.ts";
import { randomUUID } from "node:crypto";
import type { CandidateIn, ChatMessage, CompletionResult, DecideRequest, DecideResponse, ToolDef } from "./types.ts";

const MAX_TOOL_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 8000;
const HISTORY_BUDGET_TOKENS = 6000;

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

export type ToolCallDelta = { index: number; id?: string; name?: string; argsFragment?: string };

export type StreamCompleteFn = (
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  callbacks: { onDelta: (text: string) => void; onToolCallDelta: (delta: ToolCallDelta) => void },
  signal?: AbortSignal
) => Promise<CompletionResult>;

export interface ChatStreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallDelta: (delta: ToolCallDelta) => void;
  onToolResult: (index: number, name: string, result: string) => void;
  onSources?: (results: WebSearchResult[]) => void;
  signal?: AbortSignal;
}

export interface ChatDeps {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  availableCandidates: () => CandidateIn[];
  availableToolCandidates: () => CandidateIn[];
  completeByProvider: Record<string, (model: string, messages: ChatMessage[], tools: ToolDef[]) => Promise<CompletionResult>>;
  completeStreamByProvider?: Record<string, StreamCompleteFn>;
  toolExecutors: Record<string, ToolExecutor>;
  webSearchExecutor: (query: string, maxResults?: number) => Promise<WebSearchResponse>;
}

const defaultDeps: ChatDeps = {
  decide: defaultDecide,
  availableCandidates: defaultAvailableCandidates,
  availableToolCandidates: defaultAvailableToolCandidates,
  completeByProvider: {
    omnirouter: omniRouterComplete,
  },
  completeStreamByProvider: {
    omnirouter: omniRouterCompleteStream,
  },
  toolExecutors: {
    scrape: (args) => callScrape(String(args.url)),
  },
  webSearchExecutor: (query, maxResults) => callWebSearch(query, maxResults),
};

function decideRequest(
  decisionKind: DecideRequest["decision_kind"],
  candidates: CandidateIn[],
  messages: ChatMessage[],
  correlationId: string
): DecideRequest {
  return {
    task: {
      type: "chat",
      data_classification: "internal",
      estimated_context_tokens: estimateContextTokens("", Object.values(TOOL_DEFS), messages),
    },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: decisionKind,
    candidates,
    policy_set: "default",
    correlation_id: correlationId,
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
  history: ChatMessage[],
  deps: ChatDeps = defaultDeps,
  streamCallbacks?: ChatStreamCallbacks
): Promise<{ selectedCandidateId: string; reply: string; toolsUsed: string[] }> {
  const correlationId = randomUUID();
  const candidates = deps.availableCandidates();
  const messages = trimHistory(history, HISTORY_BUDGET_TOKENS);
  const failedCandidates = new Set<string>();

  const selectModel = async (available: CandidateIn[]): Promise<CandidateIn> => {
    const decision = await deps.decide(decideRequest("model_selection", available, messages, correlationId));
    if (decision.requires_human_approval) {
      throw new Error("MADE requires human approval for this request");
    }
    if (!decision.selected_candidate_id) {
      throw new Error("MADE returned no eligible candidate; service degraded");
    }
    const candidate = available.find((c) => c.id === decision.selected_candidate_id);
    if (!candidate) {
      throw new Error(`MADE selected unknown candidate id ${decision.selected_candidate_id}`);
    }
    return candidate;
  };

  let selected = await selectModel(candidates);
  let complete = deps.completeByProvider[selected.vendor];
  let completeStreamFn = deps.completeStreamByProvider?.[selected.vendor];
  const availableAfterFailure = () => candidates.filter((candidate) => !failedCandidates.has(candidate.id));
  const reselectAfterFailure = async (error: unknown): Promise<void> => {
    const failedId = selected.id;
    failedCandidates.add(failedId);
    const remaining = availableAfterFailure();
    if (remaining.length === 0) {
      throw new Error(`model ${failedId} failed and no fallback candidates remain: ${(error as Error).message}`);
    }
    selected = await selectModel(remaining);
    complete = deps.completeByProvider[selected.vendor];
    completeStreamFn = deps.completeStreamByProvider?.[selected.vendor];
  };
  if (!complete && !streamCallbacks) {
    throw new Error(`no provider client registered for vendor ${selected.vendor}`);
  }
  if (streamCallbacks && !completeStreamFn) {
    throw new Error(`no streaming provider client registered for vendor ${selected.vendor}`);
  }

  const toolCandidates = deps.availableToolCandidates();
  const toolDecision = await deps.decide(decideRequest("tool_selection", toolCandidates, messages, correlationId));
  if (toolDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }
  const allowedToolIds = new Set(toolDecision.ranking.map((r) => r.id));
  const tools: ToolDef[] = toolCandidates
    .filter((c) => allowedToolIds.has(c.id))
    .map((c) => TOOL_DEFS[c.id])
    .filter((t): t is ToolDef => Boolean(t));

  const toolsUsed: string[] = [];
  let lastNonEmptyContent: string | null = null;
  let citationOffset = 0;
  const allSources: WebSearchResult[] = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const currentEstimate = estimateContextTokens("", Object.values(TOOL_DEFS), messages);
    const capacity = await ensureCandidateFits(
      selected,
      availableAfterFailure(),
      currentEstimate,
      decideRequest("model_selection", availableAfterFailure(), messages, correlationId),
      deps.decide
    );

    if (capacity.status === "exhausted") {
      if (lastNonEmptyContent) {
        return {
          selectedCandidateId: selected.id,
          reply: `${lastNonEmptyContent}\n\n[context window exhausted — response may be incomplete]`,
          toolsUsed,
        };
      }
      throw new Error("MADE returned no eligible candidate");
    }

    if (capacity.status === "switched") {
      selected = capacity.candidate;
      const nextComplete = deps.completeByProvider[selected.vendor];
      if (!nextComplete && !streamCallbacks) {
        throw new Error(`no provider client registered for vendor ${selected.vendor}`);
      }
      complete = nextComplete;
      const nextCompleteStream = deps.completeStreamByProvider?.[selected.vendor];
      if (streamCallbacks && !nextCompleteStream) {
        throw new Error(`no streaming provider client registered for vendor ${selected.vendor}`);
      }
      completeStreamFn = nextCompleteStream;
    }

    let result: CompletionResult;
    try {
      if (streamCallbacks) {
        result = await completeStreamFn!(
          selected.id,
          messages,
          tools,
          { onDelta: streamCallbacks.onDelta, onToolCallDelta: streamCallbacks.onToolCallDelta },
          streamCallbacks.signal
        );
      } else {
        result = await complete(selected.id, messages, tools);
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      await reselectAfterFailure(error);
      i -= 1;
      continue;
    }

    if (result.content) {
      lastNonEmptyContent = result.content;
    }

    if (result.toolCalls.length === 0) {
      return { selectedCandidateId: selected.id, reply: result.content ?? "", toolsUsed };
    }

    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    for (const [index, call] of result.toolCalls.entries()) {
      let toolResult: string;
      // Treat MADE's tool ranking as an allowlist, not merely a hint. A
      // provider must not be able to bypass the policy by emitting a call for
      // a tool that was not included in the request's approved definitions.
      if (!allowedToolIds.has(call.function.name)) {
        toolResult = `tool ${call.function.name} denied by policy`;
      } else if (call.function.name === "web_search") {
        try {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
          const response = await deps.webSearchExecutor(String(args.query ?? ""), maxResults);
          toolResult = formatWebSearchResults(response, citationOffset);
          citationOffset += response.results.length;
          allSources.push(...response.results);
          streamCallbacks?.onSources?.(allSources.slice());
          toolsUsed.push("web_search");
        } catch (err) {
          toolResult = `web_search failed: ${(err as Error).message}`;
        }
      } else {
        const executor = deps.toolExecutors[call.function.name];
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
      }
      streamCallbacks?.onToolResult(index, call.function.name, toolResult);
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
