import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAgentTurn } from "../src/agent-turn.ts";
import type { AgentTurnDeps, AgentTurnRequest } from "../src/agent-turn.ts";
import type { DecideResponse } from "../src/types.ts";

const modelDecision: DecideResponse = {
  decision_id: "d1",
  selected_candidate_id: "gemma4-12b",
  requires_human_approval: false,
  ranking: [],
  excluded: [],
  technique_used: "topsis",
  policy_version: "1",
};

const baseDeps: Pick<AgentTurnDeps, "decide" | "availableCandidates"> = {
  decide: async () => modelDecision,
  availableCandidates: () => [
    { id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const, cost_per_1k_tokens: 0, scores: {} },
  ],
};

const docTool = { name: "insert_content", description: "insert text", inputSchema: { type: "object" } };
const baseRequest: AgentTurnRequest = {
  system: "you are a helpful assistant",
  messages: [{ role: "user", text: "hello" }],
  tools: [docTool],
};

test("handleAgentTurn() returns final text when the model calls no tools", async () => {
  let estimatedTokensSeen = 0;
  const deps: AgentTurnDeps = {
    ...baseDeps,
    decide: async (request) => {
      estimatedTokensSeen = request.task.estimated_context_tokens ?? 0;
      return modelDecision;
    },
    completeByProvider: {
      "ollama-local": async (_model, messages, tools) => {
        assert.equal(messages[0].role, "system");
        assert.deepEqual(
          tools.map((t) => t.function.name).sort(),
          ["insert_content", "scrape", "web_search"]
        );
        return { content: "hi there", toolCalls: [] };
      },
    },
    serverToolExecutors: {},
    webSearchExecutor: async () => {
      throw new Error("should not be called");
    },
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.ok(estimatedTokensSeen > 0);
  assert.deepEqual(result, { type: "text", text: "hi there" });
});

test("handleAgentTurn() hands an unrecognized (document) tool call back unexecuted", async () => {
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [
          { id: "call_1", type: "function" as const, function: { name: "insert_content", arguments: '{"text":"hi"}' } },
        ],
      }),
    },
    serverToolExecutors: {
      web_search: async () => {
        throw new Error("should not be called");
      },
    },
    webSearchExecutor: async () => {
      throw new Error("should not be called");
    },
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.deepEqual(result, {
    type: "tool_calls",
    calls: [{ id: "call_1", name: "insert_content", input: { text: "hi" } }],
    text: undefined,
  });
});

test("handleAgentTurn() executes web_search/scrape internally and loops without surfacing them", async () => {
  let callCount = 0;
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"weather"}' } },
            ],
          };
        }
        const toolMsg = messages.find((m) => m.role === "tool");
        return { content: `answer using: ${toolMsg?.content}`, toolCalls: [] };
      },
    },
    serverToolExecutors: {},
    webSearchExecutor: async (query) => ({ results: [{ title: "R", url: "https://x.example", snippet: `results for ${query}` }] }),
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.equal(callCount, 2);
  assert.deepEqual(result, {
    type: "text",
    text: "answer using: [1] R\n    results for weather\n    https://x.example",
  });
});

test("handleAgentTurn() does not add a duplicate tool def when the client already sent one with the same name", async () => {
  const clientWebSearch = { name: "web_search", description: "client-defined", inputSchema: { type: "object" } };
  const request: AgentTurnRequest = { ...baseRequest, tools: [docTool, clientWebSearch] };
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async (_model, _messages, tools) => {
        assert.equal(tools.filter((t) => t.function.name === "web_search").length, 1);
        return { content: "ok", toolCalls: [] };
      },
    },
    serverToolExecutors: {},
    webSearchExecutor: async () => {
      throw new Error("should not be called");
    },
  };

  await handleAgentTurn(request, deps);
});

test("handleAgentTurn() switches to a different candidate mid-loop when the estimate exceeds the current candidate's window", async () => {
  const smallOllama = {
    id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const,
    cost_per_1k_tokens: 0, scores: {}, context_window_tokens: 1300,
  };
  const bigDeepseek = {
    id: "deepseek-v4-flash", vendor: "deepseek", kind: "model" as const,
    cost_per_1k_tokens: 0.001, scores: {}, context_window_tokens: 1_000_000,
  };
  const candidates = [smallOllama, bigDeepseek];

  let decideCalls = 0;
  const deps: AgentTurnDeps = {
    availableCandidates: () => candidates,
    decide: async () => {
      decideCalls += 1;
      if (decideCalls === 1) {
        return { ...modelDecision, selected_candidate_id: "gemma4-12b" };
      }
      return { ...modelDecision, selected_candidate_id: "deepseek-v4-flash" };
    },
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [
          { id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"x"}' } },
        ],
      }),
      deepseek: async (_model, messages) => {
        const toolMsg = messages.find((m) => m.role === "tool");
        return { content: `answered by deepseek using: ${toolMsg?.content}`, toolCalls: [] };
      },
    },
    serverToolExecutors: {},
    webSearchExecutor: async () => ({ results: [{ title: "", url: "", snippet: "x".repeat(1000) }] }),
  };

  const result = await handleAgentTurn(baseRequest, deps);

  // iteration 0 estimate for baseRequest's exact shape is 1200 (fits 1300, no switch yet);
  // after the first server-tool round-trip, iteration 1's estimate is 1509 (exceeds 1300, triggers the switch).
  assert.equal(decideCalls, 2);
  assert.deepEqual(result, {
    type: "text",
    text: `answered by deepseek using: [1] \n    ${"x".repeat(1000)}\n    `,
  });
});

test("handleAgentTurn() returns the last non-empty text with a note when MADE finds no candidate that fits mid-loop", async () => {
  const smallOllama = {
    id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const,
    cost_per_1k_tokens: 0, scores: {}, context_window_tokens: 1300,
  };
  const candidates = [smallOllama];

  let decideCalls = 0;
  const deps: AgentTurnDeps = {
    availableCandidates: () => candidates,
    decide: async () => {
      decideCalls += 1;
      if (decideCalls === 1) {
        return { ...modelDecision, selected_candidate_id: "gemma4-12b" };
      }
      return { ...modelDecision, selected_candidate_id: null };
    },
    completeByProvider: {
      "ollama-local": async () => ({
        content: "partial answer",
        toolCalls: [
          { id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"x"}' } },
        ],
      }),
    },
    serverToolExecutors: {},
    webSearchExecutor: async () => ({ results: [{ title: "", url: "", snippet: "x".repeat(1000) }] }),
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.deepEqual(result, {
    type: "text",
    text: "partial answer\n\n[context window exhausted — response may be incomplete]",
  });
});

test("handleAgentTurn() throws when MADE selects no candidate", async () => {
  await assert.rejects(
    () =>
      handleAgentTurn(baseRequest, {
        ...baseDeps,
        decide: async () => ({ ...modelDecision, selected_candidate_id: null }),
        completeByProvider: {},
        serverToolExecutors: {},
        webSearchExecutor: async () => {
          throw new Error("should not be called");
        },
      }),
    /MADE returned no eligible candidate/
  );
});

test("handleAgentTurn() throws when MADE requires human approval", async () => {
  await assert.rejects(
    () =>
      handleAgentTurn(baseRequest, {
        ...baseDeps,
        decide: async () => ({ ...modelDecision, requires_human_approval: true }),
        completeByProvider: {},
        serverToolExecutors: {},
        webSearchExecutor: async () => {
          throw new Error("should not be called");
        },
      }),
    /MADE requires human approval for this request/
  );
});

test("handleAgentTurn() throws once the internal server-tool loop exceeds its iteration cap", async () => {
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [{ id: "call_x", type: "function" as const, function: { name: "web_search", arguments: "{}" } }],
      }),
    },
    serverToolExecutors: {},
    webSearchExecutor: async () => ({ results: [{ title: "R", url: "https://x.example", snippet: "result" }] }),
  };

  await assert.rejects(() => handleAgentTurn(baseRequest, deps), /agent-turn tool loop exceeded maximum iterations/);
});

test("handleAgentTurn() calls completeStreamByProvider instead of completeByProvider when streamCallbacks is provided", async () => {
  const deltas: string[] = [];
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async () => {
        throw new Error("should not be called");
      },
    },
    completeStreamByProvider: {
      "ollama-local": async (_model, _messages, _tools, callbacks) => {
        callbacks.onDelta("streamed reply");
        return { content: "streamed reply", toolCalls: [] };
      },
    },
    serverToolExecutors: {},
    webSearchExecutor: async () => {
      throw new Error("should not be called");
    },
  };

  const result = await handleAgentTurn(baseRequest, deps, {
    onDelta: (t) => deltas.push(t),
    onToolCallDelta: () => {},
    onToolResult: () => {},
  });

  assert.deepEqual(deltas, ["streamed reply"]);
  assert.deepEqual(result, { type: "text", text: "streamed reply" });
});

test("handleAgentTurn() calls onToolResult after executing a server tool when streaming", async () => {
  let callCount = 0;
  const toolResults: { index: number; name: string; result: string }[] = [];
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {},
    completeStreamByProvider: {
      "ollama-local": async (_model, _messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"x"}' } },
            ],
          };
        }
        return { content: "answer", toolCalls: [] };
      },
    },
    serverToolExecutors: {},
    webSearchExecutor: async (query) => ({ results: [{ title: "R", url: "https://x.example", snippet: `results for ${query}` }] }),
  };

  await handleAgentTurn(baseRequest, deps, {
    onDelta: () => {},
    onToolCallDelta: () => {},
    onToolResult: (index, name, result) => toolResults.push({ index, name, result }),
  });

  assert.deepEqual(toolResults, [
    { index: 0, name: "web_search", result: "[1] R\n    results for x\n    https://x.example" },
  ]);
});

test("handleAgentTurn() falls back to non-streaming completeByProvider when streamCallbacks is omitted", async () => {
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {
      "ollama-local": async () => ({ content: "non-streamed", toolCalls: [] }),
    },
    serverToolExecutors: {},
    webSearchExecutor: async () => {
      throw new Error("should not be called");
    },
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.deepEqual(result, { type: "text", text: "non-streamed" });
});

test("handleAgentTurn() calls onSources with the accumulated results after each web_search call", async () => {
  let callCount = 0;
  const sourcesSeen: unknown[] = [];
  const deps: AgentTurnDeps = {
    ...baseDeps,
    completeByProvider: {},
    completeStreamByProvider: {
      "ollama-local": async (_model, _messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", type: "function" as const, function: { name: "web_search", arguments: '{"query":"a"}' } }],
          };
        }
        if (callCount === 2) {
          return {
            content: "",
            toolCalls: [{ id: "call_2", type: "function" as const, function: { name: "web_search", arguments: '{"query":"b"}' } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    },
    serverToolExecutors: {},
    webSearchExecutor: async (query) => ({ results: [{ title: query, url: `https://${query}.example`, snippet: "s" }] }),
  };

  await handleAgentTurn(baseRequest, deps, {
    onDelta: () => {},
    onToolCallDelta: () => {},
    onToolResult: () => {},
    onSources: (results) => sourcesSeen.push(results),
  });

  assert.deepEqual(sourcesSeen, [
    [{ title: "a", url: "https://a.example", snippet: "s" }],
    [{ title: "a", url: "https://a.example", snippet: "s" }, { title: "b", url: "https://b.example", snippet: "s" }],
  ]);
});
