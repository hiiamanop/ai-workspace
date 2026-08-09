import { test } from "node:test";
import assert from "node:assert/strict";
import { handleChat } from "../src/chat.ts";
import type { DecideResponse } from "../src/types.ts";

test("handleChat() asks MADE, then dispatches to the selected candidate's provider", async () => {
  const fakeDecideResponse: DecideResponse = {
    decision_id: "d1",
    selected_candidate_id: "gemma4:12b",
    requires_human_approval: false,
    ranking: [],
    excluded: [],
    technique_used: "topsis",
    policy_version: "1",
  };

  let decideCalledWithMessageType = "";
  const reply = await handleChat("hello there", {
    decide: async (request) => {
      decideCalledWithMessageType = request.task.type;
      return fakeDecideResponse;
    },
    availableCandidates: () => [
      { id: "gemma4:12b", vendor: "ollama-local", kind: "model", cost_per_1k_tokens: 0, scores: {} },
    ],
    completeByProvider: {
      "ollama-local": async (_model, prompt) => `echo: ${prompt}`,
      deepseek: async () => {
        throw new Error("should not be called");
      },
    },
  });

  assert.equal(decideCalledWithMessageType, "chat");
  assert.equal(reply.selectedCandidateId, "gemma4:12b");
  assert.equal(reply.reply, "echo: hello there");
});

test("handleChat() throws when MADE selects no candidate", async () => {
  await assert.rejects(
    () =>
      handleChat("hello", {
        decide: async () => ({
          decision_id: "d1",
          selected_candidate_id: null,
          requires_human_approval: false,
          ranking: [],
          excluded: [{ id: "gemma4:12b", reason: "denied" }],
          technique_used: "topsis",
          policy_version: "1",
        }),
        availableCandidates: () => [
          { id: "gemma4:12b", vendor: "ollama-local", kind: "model", cost_per_1k_tokens: 0, scores: {} },
        ],
        completeByProvider: {},
      }),
    /MADE returned no eligible candidate/
  );
});
