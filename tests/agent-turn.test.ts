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
    serverToolExecutors: {
      web_search: async (args) => `results for ${args.query}`,
    },
  };

  const result = await handleAgentTurn(baseRequest, deps);

  assert.equal(callCount, 2);
  assert.deepEqual(result, { type: "text", text: "answer using: results for weather" });
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
  };

  await handleAgentTurn(request, deps);
});

test("handleAgentTurn() throws when MADE selects no candidate", async () => {
  await assert.rejects(
    () =>
      handleAgentTurn(baseRequest, {
        ...baseDeps,
        decide: async () => ({ ...modelDecision, selected_candidate_id: null }),
        completeByProvider: {},
        serverToolExecutors: {},
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
    serverToolExecutors: {
      web_search: async () => "result",
    },
  };

  await assert.rejects(() => handleAgentTurn(baseRequest, deps), /agent-turn tool loop exceeded maximum iterations/);
});
