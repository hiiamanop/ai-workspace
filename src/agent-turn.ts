import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates } from "./candidates.ts";
import { complete as ollamaComplete, completeStream as ollamaCompleteStream } from "./providers/ollama-client.ts";
import { complete as deepseekComplete, completeStream as deepseekCompleteStream } from "./providers/deepseek-client.ts";
import { callWebSearch, type WebSearchResponse, type WebSearchResult } from "./mcp/searxng-client.ts";
import { formatWebSearchResults } from "./web-search-format.ts";
import { callScrape } from "./mcp/scrapling-client.ts";
import { TOOL_DEFS } from "./tools.ts";
import { estimateContextTokens } from "./token-estimate.ts";
import { ensureCandidateFits } from "./context-guard.ts";
import type { CandidateIn, ChatMessage, CompletionResult, DecideRequest, DecideResponse, ToolDef } from "./types.ts";

const MAX_TURN_ITERATIONS = 5;
const MAX_TOOL_RESULT_CHARS = 8000;
const SERVER_TOOL_NAMES = new Set(["web_search", "scrape"]);

export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResult {
  id: string;
  name: string;
  output: string;
  isError?: boolean;
}

export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: AgentToolCall[] }
  | { role: "tool"; results: AgentToolResult[] };

export interface AgentTurnRequest {
  system: string;
  messages: AgentMessage[];
  tools: AgentToolDef[];
}

export type AgentTurnResult =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: AgentToolCall[]; text?: string };

export type ToolCallDelta = { index: number; id?: string; name?: string; argsFragment?: string };

export type StreamCompleteFn = (
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  callbacks: { onDelta: (text: string) => void; onToolCallDelta: (delta: ToolCallDelta) => void },
  signal?: AbortSignal
) => Promise<CompletionResult>;

export interface AgentTurnStreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallDelta: (delta: ToolCallDelta) => void;
  onToolResult: (index: number, name: string, result: string) => void;
  onSources?: (results: WebSearchResult[]) => void;
  signal?: AbortSignal;
}

export interface AgentTurnDeps {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  availableCandidates: () => CandidateIn[];
  completeByProvider: Record<string, (model: string, messages: ChatMessage[], tools: ToolDef[]) => Promise<CompletionResult>>;
  completeStreamByProvider?: Record<string, StreamCompleteFn>;
  serverToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>>;
  webSearchExecutor: (query: string, maxResults?: number) => Promise<WebSearchResponse>;
}

const defaultDeps: AgentTurnDeps = {
  decide: defaultDecide,
  availableCandidates: defaultAvailableCandidates,
  completeByProvider: {
    "ollama-local": ollamaComplete,
    deepseek: deepseekComplete,
  },
  completeStreamByProvider: {
    "ollama-local": ollamaCompleteStream,
    deepseek: deepseekCompleteStream,
  },
  serverToolExecutors: {
    scrape: (args) => callScrape(String(args.url)),
  },
  webSearchExecutor: (query, maxResults) => callWebSearch(query, maxResults),
};

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

function toChatMessages(system: string, messages: AgentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        tool_calls: m.toolCalls?.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      });
    } else {
      for (const r of m.results) {
        out.push({ role: "tool", content: r.output, tool_call_id: r.id, name: r.name });
      }
    }
  }
  return out;
}

function mergeTools(clientTools: AgentToolDef[]): ToolDef[] {
  const names = new Set(clientTools.map((t) => t.name));
  const merged: ToolDef[] = clientTools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  for (const name of SERVER_TOOL_NAMES) {
    if (!names.has(name) && TOOL_DEFS[name]) {
      merged.push(TOOL_DEFS[name]);
    }
  }
  return merged;
}

function decideRequest(candidates: CandidateIn[], tools: ToolDef[], messages: ChatMessage[]): DecideRequest {
  return {
    task: {
      type: "chat",
      data_classification: "internal",
      estimated_context_tokens: estimateContextTokens("", tools, messages),
    },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: "model_selection",
    candidates,
    policy_set: "default",
  };
}

export async function handleAgentTurn(
  request: AgentTurnRequest,
  deps: AgentTurnDeps = defaultDeps,
  streamCallbacks?: AgentTurnStreamCallbacks
): Promise<AgentTurnResult> {
  const candidates = deps.availableCandidates();
  const tools = mergeTools(request.tools);
  const messages = toChatMessages(request.system, request.messages);
  const modelDecision = await deps.decide(decideRequest(candidates, tools, messages));

  if (!modelDecision.selected_candidate_id) {
    throw new Error("MADE returned no eligible candidate");
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

  let lastNonEmptyText: string | null = null;
  let citationOffset = 0;
  const allSources: WebSearchResult[] = [];

  for (let i = 0; i < MAX_TURN_ITERATIONS; i++) {
    const currentEstimate = estimateContextTokens("", tools, messages);
    const capacity = await ensureCandidateFits(
      selected,
      candidates,
      currentEstimate,
      decideRequest(candidates, tools, messages),
      deps.decide
    );

    if (capacity.status === "exhausted") {
      if (lastNonEmptyText) {
        return { type: "text", text: `${lastNonEmptyText}\n\n[context window exhausted — response may be incomplete]` };
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

    const result = streamCallbacks
      ? await completeStreamFn!(
          selected.id,
          messages,
          tools,
          { onDelta: streamCallbacks.onDelta, onToolCallDelta: streamCallbacks.onToolCallDelta },
          streamCallbacks.signal
        )
      : await complete(selected.id, messages, tools);

    if (result.content) {
      lastNonEmptyText = result.content;
    }

    if (result.toolCalls.length === 0) {
      return { type: "text", text: result.content ?? "" };
    }

    const hasClientCall = result.toolCalls.some((c) => !SERVER_TOOL_NAMES.has(c.function.name));
    if (hasClientCall) {
      return {
        type: "tool_calls",
        calls: result.toolCalls.map((c) => ({
          id: c.id,
          name: c.function.name,
          input: JSON.parse(c.function.arguments) as Record<string, unknown>,
        })),
        text: result.content || undefined,
      };
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
        } catch (err) {
          toolResult = `web_search failed: ${(err as Error).message}`;
        }
      } else {
        const executor = deps.serverToolExecutors[call.function.name];
        try {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          toolResult = executor ? await executor(args) : `tool ${call.function.name} is not available`;
        } catch (err) {
          toolResult = `${call.function.name} failed: ${(err as Error).message}`;
        }
      }
      streamCallbacks?.onToolResult(index, call.function.name, toolResult);
      messages.push({ role: "tool", content: truncateToolResult(toolResult), tool_call_id: call.id, name: call.function.name });
    }
  }

  throw new Error("agent-turn tool loop exceeded maximum iterations");
}
