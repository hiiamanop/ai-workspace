import { test } from "node:test";
import assert from "node:assert/strict";
import { handleChat } from "../src/chat.ts";
import type { ChatDeps } from "../src/chat.ts";
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

function noToolsDecision(): DecideResponse {
  return {
    decision_id: "d2",
    selected_candidate_id: null,
    requires_human_approval: false,
    ranking: [],
    excluded: [
      { id: "web_search", reason: "denied" },
      { id: "scrape", reason: "denied" },
    ],
    technique_used: "topsis",
    policy_version: "1",
  };
}

function allowAllToolsDecision(): DecideResponse {
  return {
    decision_id: "d2",
    selected_candidate_id: "web_search",
    requires_human_approval: false,
    ranking: [
      { id: "web_search", score: 0.8 },
      { id: "scrape", score: 0.6 },
    ],
    excluded: [],
    technique_used: "topsis",
    policy_version: "1",
  };
}

const baseDeps = {
  availableCandidates: () => [
    { id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const, cost_per_1k_tokens: 0, scores: {} },
  ],
  availableToolCandidates: () => [
    { id: "web_search", vendor: "mcp-searxng", kind: "tool" as const, cost_per_1k_tokens: 0, scores: {} },
    { id: "scrape", vendor: "scrapling", kind: "tool" as const, cost_per_1k_tokens: 0, scores: {} },
  ],
};

test("handleChat() skips tool wiring entirely when MADE allows no tools", async () => {
  const decideCalls: string[] = [];
  const estimatedTokensSeen: number[] = [];
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => {
      decideCalls.push(request.decision_kind);
      estimatedTokensSeen.push(request.task.estimated_context_tokens ?? 0);
      return request.decision_kind === "model_selection" ? modelDecision : noToolsDecision();
    },
    completeByProvider: {
      "ollama-local": async (_model, messages, tools) => {
        assert.deepEqual(tools, []);
        return { content: `echo: ${messages[0].content}`, toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {},
  };

  const result = await handleChat([{ role: "user", content: "hello there" }], deps);

  assert.deepEqual(decideCalls, ["model_selection", "tool_selection"]);
  assert.ok(estimatedTokensSeen.every((n) => n > 0));
  assert.equal(result.selectedCandidateId, "gemma4-12b");
  assert.equal(result.reply, "echo: hello there");
  assert.deepEqual(result.toolsUsed, []);
});

test("handleChat() executes a requested tool call and feeds the result back to the model", async () => {
  let callCount = 0;
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"jakarta weather"}' } },
            ],
          };
        }
        const toolMessage = messages.find((m) => m.role === "tool");
        return { content: `final reply using: ${toolMessage?.content}`, toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async (args) => `search results for ${args.query}`,
    },
  };

  const result = await handleChat([{ role: "user", content: "what's the weather in jakarta?" }], deps);

  assert.equal(callCount, 2);
  assert.equal(result.reply, "final reply using: search results for jakarta weather");
  assert.deepEqual(result.toolsUsed, ["web_search"]);
});

test("handleChat() feeds an error string back to the model when a tool executor throws", async () => {
  let callCount = 0;
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
          };
        }
        const toolMessage = messages.find((m) => m.role === "tool");
        return { content: `handled: ${toolMessage?.content}`, toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => {
        throw new Error("subprocess failed to spawn");
      },
    },
  };

  const result = await handleChat([{ role: "user", content: "search something" }], deps);

  assert.match(result.reply, /handled: web_search failed: subprocess failed to spawn/);
  assert.deepEqual(result.toolsUsed, []);
});

test("handleChat() throws when MADE selects no candidate", async () => {
  await assert.rejects(
    () =>
      handleChat([{ role: "user", content: "hello" }], {
        ...baseDeps,
        decide: async (request) =>
          request.decision_kind === "model_selection"
            ? {
                decision_id: "d1",
                selected_candidate_id: null,
                requires_human_approval: false,
                ranking: [],
                excluded: [{ id: "gemma4-12b", reason: "denied" }],
                technique_used: "topsis",
                policy_version: "1",
              }
            : noToolsDecision(),
        completeByProvider: {},
        toolExecutors: {},
      }),
    /MADE returned no eligible candidate/
  );
});

test("handleChat() throws when MADE requires human approval", async () => {
  await assert.rejects(
    () =>
      handleChat([{ role: "user", content: "hello" }], {
        ...baseDeps,
        decide: async (request) =>
          request.decision_kind === "model_selection"
            ? {
                decision_id: "d1",
                selected_candidate_id: "gemma4-12b",
                requires_human_approval: true,
                ranking: [],
                excluded: [],
                technique_used: "topsis",
                policy_version: "1",
              }
            : noToolsDecision(),
        completeByProvider: {},
        toolExecutors: {},
      }),
    /MADE requires human approval for this request/
  );
});

test("handleChat() throws when MADE requires human approval for tool_selection", async () => {
  await assert.rejects(
    () =>
      handleChat([{ role: "user", content: "hello" }], {
        ...baseDeps,
        decide: async (request) =>
          request.decision_kind === "model_selection"
            ? modelDecision
            : {
                decision_id: "d2",
                selected_candidate_id: "web_search",
                requires_human_approval: true,
                ranking: [],
                excluded: [],
                technique_used: "topsis",
                policy_version: "1",
              },
        completeByProvider: {
          "ollama-local": async () => {
            throw new Error("should not be called");
          },
        },
        toolExecutors: {},
      }),
    /MADE requires human approval for this request/
  );
});

test("handleChat() switches to a different candidate mid-loop when the estimate exceeds the current candidate's window", async () => {
  const smallOllama = {
    id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const,
    cost_per_1k_tokens: 0, scores: {}, context_window_tokens: 1200,
  };
  const bigDeepseek = {
    id: "deepseek-v4-flash", vendor: "deepseek", kind: "model" as const,
    cost_per_1k_tokens: 0.001, scores: {}, context_window_tokens: 1_000_000,
  };
  const candidates = [smallOllama, bigDeepseek];

  let modelDecideCalls = 0;
  const deps: ChatDeps = {
    availableCandidates: () => candidates,
    availableToolCandidates: baseDeps.availableToolCandidates,
    decide: async (request) => {
      if (request.decision_kind === "tool_selection") return allowAllToolsDecision();
      modelDecideCalls += 1;
      if (modelDecideCalls === 1) {
        return { ...modelDecision, selected_candidate_id: "gemma4-12b" };
      }
      return { ...modelDecision, selected_candidate_id: "deepseek-v4-flash" };
    },
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
      }),
      deepseek: async (_model, messages) => {
        const toolMessage = messages.find((m) => m.role === "tool");
        return { content: `answered by deepseek using: ${toolMessage?.content}`, toolCalls: [] };
      },
    },
    toolExecutors: {
      web_search: async () => "x".repeat(1000),
    },
  };

  const result = await handleChat([{ role: "user", content: "search something" }], deps);

  // iteration 0 estimate for this exact message/tool shape is 1115 (fits 1200, no switch yet);
  // after the first tool round-trip, iteration 1's estimate is 1417 (exceeds 1200, triggers the switch).
  assert.equal(modelDecideCalls, 2);
  assert.equal(result.selectedCandidateId, "deepseek-v4-flash");
  assert.match(result.reply, /^answered by deepseek using:/);
});

test("handleChat() returns the last non-empty content with a note when MADE finds no candidate that fits mid-loop", async () => {
  const smallOllama = {
    id: "gemma4-12b", vendor: "ollama-local", kind: "model" as const,
    cost_per_1k_tokens: 0, scores: {}, context_window_tokens: 1200,
  };
  const candidates = [smallOllama];

  let modelDecideCalls = 0;
  const deps: ChatDeps = {
    availableCandidates: () => candidates,
    availableToolCandidates: baseDeps.availableToolCandidates,
    decide: async (request) => {
      if (request.decision_kind === "tool_selection") return allowAllToolsDecision();
      modelDecideCalls += 1;
      if (modelDecideCalls === 1) {
        return { ...modelDecision, selected_candidate_id: "gemma4-12b" };
      }
      return { ...modelDecision, selected_candidate_id: null };
    },
    completeByProvider: {
      "ollama-local": async () => ({
        content: "partial thought",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
      }),
    },
    toolExecutors: {
      web_search: async () => "x".repeat(1000),
    },
  };

  const result = await handleChat([{ role: "user", content: "search something" }], deps);

  assert.equal(result.reply, "partial thought\n\n[context window exhausted — response may be incomplete]");
});

test("handleChat() truncates tool results longer than 8000 chars before feeding them back to the model", async () => {
  const longResult = "x".repeat(9000);
  let capturedToolContent = "";
  let callCount = 0;
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
          };
        }
        const toolMessage = messages.find((m) => m.role === "tool");
        capturedToolContent = toolMessage?.content ?? "";
        return { content: "done", toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => longResult,
    },
  };

  await handleChat([{ role: "user", content: "search something huge" }], deps);

  assert.equal(capturedToolContent.length, 8000 + "...[truncated, 9000 chars total]".length);
  assert.ok(capturedToolContent.startsWith("x".repeat(8000)));
  assert.ok(capturedToolContent.endsWith("...[truncated, 9000 chars total]"));
});

test("handleChat() does not alter tool results at or under 8000 chars", async () => {
  const shortResult = "y".repeat(8000);
  let capturedToolContent = "";
  let callCount = 0;
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
          };
        }
        const toolMessage = messages.find((m) => m.role === "tool");
        capturedToolContent = toolMessage?.content ?? "";
        return { content: "done", toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => shortResult,
    },
  };

  await handleChat([{ role: "user", content: "search something" }], deps);

  assert.equal(capturedToolContent, shortResult);
});

test("handleChat() returns the last non-empty content with a note when the tool loop hits the iteration cap", async () => {
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async () => ({
        content: "partial thought",
        toolCalls: [{ id: "call_x", type: "function", function: { name: "web_search", arguments: "{}" } }],
      }),
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => "result",
    },
  };

  const result = await handleChat([{ role: "user", content: "loop forever" }], deps);

  assert.equal(result.reply, "partial thought\n\n[tool loop limit reached — response may be incomplete]");
});

test("handleChat() still throws when the tool loop hits the iteration cap with no content ever produced", async () => {
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async () => ({
        content: "",
        toolCalls: [{ id: "call_x", type: "function", function: { name: "web_search", arguments: "{}" } }],
      }),
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => "result",
    },
  };

  await assert.rejects(() => handleChat([{ role: "user", content: "loop forever" }], deps), /tool-calling loop exceeded maximum iterations/);
});

test("handleChat() does not split a surrogate pair when truncating a tool result", async () => {
  const emoji = "\u{1F600}"; // a single Unicode code point, 2 UTF-16 code units
  const longResult = "x".repeat(7999) + emoji + "y".repeat(1000);
  let capturedToolContent = "";
  let callCount = 0;
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) =>
      request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision(),
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
          };
        }
        const toolMessage = messages.find((m) => m.role === "tool");
        capturedToolContent = toolMessage?.content ?? "";
        return { content: "done", toolCalls: [] };
      },
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
    toolExecutors: {
      web_search: async () => longResult,
    },
  };

  await handleChat([{ role: "user", content: "search something with emoji at the truncation boundary" }], deps);

  const markerIndex = capturedToolContent.indexOf("...[truncated");
  const truncatedPortion = capturedToolContent.slice(0, markerIndex);

  // The cut must land BEFORE the emoji's high surrogate (at index 7999),
  // not in the middle of it (which an 8000-char slice would do).
  assert.equal(truncatedPortion, "x".repeat(7999));
  assert.equal(truncatedPortion.length, 7999);
  assert.ok(capturedToolContent.endsWith(`...[truncated, ${longResult.length} chars total]`));
});

test("handleChat() calls completeStreamByProvider instead of completeByProvider when streamCallbacks is provided", async () => {
  const deltas: string[] = [];
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => (request.decision_kind === "model_selection" ? modelDecision : noToolsDecision()),
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
    toolExecutors: {},
  };

  const result = await handleChat(
    [{ role: "user", content: "hello" }],
    deps,
    { onDelta: (t) => deltas.push(t), onToolCallDelta: () => {}, onToolResult: () => {} }
  );

  assert.deepEqual(deltas, ["streamed reply"]);
  assert.equal(result.reply, "streamed reply");
});

test("handleChat() calls onToolResult after executing a tool when streaming", async () => {
  let callCount = 0;
  const toolResults: { index: number; name: string; result: string }[] = [];
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => (request.decision_kind === "model_selection" ? modelDecision : allowAllToolsDecision()),
    completeByProvider: {},
    completeStreamByProvider: {
      "ollama-local": async (_model, _messages) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    },
    toolExecutors: { web_search: async () => "search result" },
  };

  await handleChat(
    [{ role: "user", content: "search something" }],
    deps,
    { onDelta: () => {}, onToolCallDelta: () => {}, onToolResult: (index, name, result) => toolResults.push({ index, name, result }) }
  );

  assert.deepEqual(toolResults, [{ index: 0, name: "web_search", result: "search result" }]);
});

test("handleChat() trims history that exceeds HISTORY_BUDGET_TOKENS before calling decide()", async () => {
  const longHistory = [
    { role: "user" as const, content: "x".repeat(30_000) },
    { role: "assistant" as const, content: "y".repeat(30_000) },
    { role: "user" as const, content: "most recent" },
  ];
  let seenMessages: typeof longHistory = [];
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => (request.decision_kind === "model_selection" ? modelDecision : noToolsDecision()),
    completeByProvider: {
      "ollama-local": async (_model, messages) => {
        seenMessages = messages as typeof longHistory;
        return { content: "ok", toolCalls: [] };
      },
    },
    toolExecutors: {},
  };

  await handleChat(longHistory, deps);

  assert.ok(seenMessages.length < longHistory.length);
  assert.equal(seenMessages[seenMessages.length - 1].content, "most recent");
});
