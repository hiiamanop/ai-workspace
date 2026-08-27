import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates, availableToolCandidates as defaultAvailableToolCandidates } from "./candidates.ts";
import { complete as deepseekComplete, completeStream as deepseekCompleteStream } from "./providers/deepseek-client.ts";
import { callWebSearch, type WebSearchResponse, type WebSearchResult } from "./mcp/searxng-client.ts";
import { formatWebSearchResults } from "./web-search-format.ts";
import { callScrape } from "./mcp/scrapling-client.ts";
import { TOOL_DEFS } from "./tools.ts";
import { estimateContextTokens } from "./token-estimate.ts";
import { ensureCandidateFits } from "./context-guard.ts";
import { trimHistory } from "./history-budget.ts";
import {
  classify as defaultClassify,
  redact as defaultRedact,
  restore as defaultRestore,
  BLOCKED_MESSAGE,
  CHAT_ORG_ID,
  type DataClassification,
} from "./privacy-client.ts";
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
  classify: (orgId: string, text: string) => Promise<DataClassification>;
  redact: (orgId: string, text: string) => Promise<{ text: string; count: number }>;
  restore: (orgId: string, text: string) => Promise<string>;
}

const defaultDeps: ChatDeps = {
  decide: defaultDecide,
  availableCandidates: defaultAvailableCandidates,
  availableToolCandidates: defaultAvailableToolCandidates,
  classify: defaultClassify,
  redact: defaultRedact,
  restore: defaultRestore,
  completeByProvider: {
    deepseek: deepseekComplete,
  },
  completeStreamByProvider: {
    deepseek: deepseekCompleteStream,
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
  dataClassification: DataClassification = "internal",
  redacted = false
): DecideRequest {
  return {
    task: {
      type: "chat",
      data_classification: dataClassification,
      redacted,
      estimated_context_tokens: estimateContextTokens("", Object.values(TOOL_DEFS), messages),
    },
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
  history: ChatMessage[],
  deps: ChatDeps = defaultDeps,
  streamCallbacks?: ChatStreamCallbacks
): Promise<{ selectedCandidateId: string; reply: string; toolsUsed: string[] }> {
  const candidates = deps.availableCandidates();
  const messages = trimHistory(history, HISTORY_BUDGET_TOKENS);

  // Classify the latest user turn, then — if it's sensitive — pseudonymise
  // every user message before anything reaches MADE or a provider. Mirrors
  // openwebui-filters/confidential_redaction.py for this surface.
  let dataClassification: DataClassification = "internal";
  let redacted = false;
  const latestUser = [...messages].reverse().find(
    (m) => m.role === "user" && typeof m.content === "string" && m.content
  );
  if (latestUser && typeof latestUser.content === "string") {
    try {
      dataClassification = await deps.classify(CHAT_ORG_ID, latestUser.content);
    } catch {
      dataClassification = "internal"; // classify unreachable — degrade, same as the filter
    }
    if (dataClassification === "confidential" || dataClassification === "restricted") {
      for (const m of messages) {
        if (m.role === "user" && typeof m.content === "string" && m.content) {
          try {
            const r = await deps.redact(CHAT_ORG_ID, m.content);
            if (r.count > 0) {
              m.content = r.text;
              redacted = true;
            }
          } catch {
            // leave this message as-is; the decide gate below still applies
          }
        }
      }
    }
  }
  const isSensitive = dataClassification === "confidential" || dataClassification === "restricted";
  const restoreReply = async (text: string): Promise<string> => {
    if (!redacted) return text;
    try {
      return await deps.restore(CHAT_ORG_ID, text);
    } catch {
      return text;
    }
  };

  const modelDecision = await deps.decide(
    decideRequest("model_selection", candidates, messages, dataClassification, redacted)
  );

  if (!modelDecision.selected_candidate_id) {
    throw new Error(isSensitive ? BLOCKED_MESSAGE : "MADE returned no eligible candidate");
  }
  if (modelDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }

  let selected = candidates.find((c) => c.id === modelDecision.selected_candidate_id);
  if (!selected) {
    throw new Error(`MADE selected unknown candidate id ${modelDecision.selected_candidate_id}`);
  }

  let complete = deps.completeByProvider[selected.vendor];
  if (!complete && !streamCallbacks) {
    throw new Error(`no provider client registered for vendor ${selected.vendor}`);
  }
  let completeStreamFn = deps.completeStreamByProvider?.[selected.vendor];
  if (streamCallbacks && !completeStreamFn) {
    throw new Error(`no streaming provider client registered for vendor ${selected.vendor}`);
  }

  const toolCandidates = deps.availableToolCandidates();
  const toolDecision = await deps.decide(
    decideRequest("tool_selection", toolCandidates, messages, dataClassification, redacted)
  );
  if (toolDecision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }

  // ponytail: when the request was redacted, buffer the streamed reply
  // instead of forwarding token deltas — a [PLACEHOLDER] can split across
  // deltas, so restore once on the complete text and emit it as one delta.
  const streamOnDelta =
    streamCallbacks && !redacted ? streamCallbacks.onDelta : () => {};
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
      candidates,
      currentEstimate,
      decideRequest("model_selection", candidates, messages, dataClassification, redacted),
      deps.decide
    );

    if (capacity.status === "exhausted") {
      if (lastNonEmptyContent) {
        const restored = await restoreReply(lastNonEmptyContent);
        return {
          selectedCandidateId: selected.id,
          reply: `${restored}\n\n[context window exhausted — response may be incomplete]`,
          toolsUsed,
        };
      }
      throw new Error(isSensitive ? BLOCKED_MESSAGE : "MADE returned no eligible candidate");
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

    const result = streamCallbacks
      ? await completeStreamFn!(
          selected.id,
          messages,
          tools,
          { onDelta: streamOnDelta, onToolCallDelta: streamCallbacks.onToolCallDelta },
          streamCallbacks.signal
        )
      : await complete(selected.id, messages, tools);

    if (result.content) {
      lastNonEmptyContent = result.content;
    }

    if (result.toolCalls.length === 0) {
      const reply = await restoreReply(result.content ?? "");
      if (streamCallbacks && redacted && reply) {
        streamCallbacks.onDelta(reply);
      }
      return { selectedCandidateId: selected.id, reply, toolsUsed };
    }

    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    for (const [index, call] of result.toolCalls.entries()) {
      let toolResult: string;
      if (call.function.name === "web_search") {
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
    const restored = await restoreReply(lastNonEmptyContent);
    return {
      selectedCandidateId: selected.id,
      reply: `${restored}\n\n[tool loop limit reached — response may be incomplete]`,
      toolsUsed,
    };
  }

  throw new Error("tool-calling loop exceeded maximum iterations");
}
