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
  const deps: ChatDeps = {
    ...baseDeps,
    decide: async (request) => {
      decideCalls.push(request.decision_kind);
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

  const result = await handleChat("hello there", deps);

  assert.deepEqual(decideCalls, ["model_selection", "tool_selection"]);
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

  const result = await handleChat("what's the weather in jakarta?", deps);

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

  const result = await handleChat("search something", deps);

  assert.match(result.reply, /handled: web_search failed: subprocess failed to spawn/);
  assert.deepEqual(result.toolsUsed, []);
});

test("handleChat() throws when MADE selects no candidate", async () => {
  await assert.rejects(
    () =>
      handleChat("hello", {
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
      handleChat("hello", {
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
