import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureCandidateFits } from "../src/context-guard.ts";
import type { CandidateIn, DecideRequest, DecideResponse } from "../src/types.ts";

const ollama: CandidateIn = {
  id: "gemma4-12b",
  vendor: "ollama-local",
  kind: "model",
  cost_per_1k_tokens: 0,
  scores: {},
  context_window_tokens: 4096,
};

const deepseek: CandidateIn = {
  id: "deepseek-v4-flash",
  vendor: "deepseek",
  kind: "model",
  cost_per_1k_tokens: 0.001,
  scores: {},
  context_window_tokens: 1_000_000,
};

const candidates = [ollama, deepseek];

const baseRequest: DecideRequest = {
  task: { type: "chat", data_classification: "internal" },
  org: { budget_remaining_usd: 1000, region: "us" },
  decision_kind: "model_selection",
  candidates: [],
  policy_set: "default",
};

function decision(overrides: Partial<DecideResponse>): DecideResponse {
  return {
    decision_id: "d1",
    selected_candidate_id: null,
    requires_human_approval: false,
    ranking: [],
    excluded: [],
    technique_used: "topsis",
    policy_version: "1",
    ...overrides,
  };
}

test("ensureCandidateFits() returns ok without calling decide() when the estimate fits", async () => {
  let decideCalls = 0;
  const result = await ensureCandidateFits(ollama, candidates, 2000, baseRequest, async () => {
    decideCalls += 1;
    return decision({});
  });

  assert.deepEqual(result, { status: "ok" });
  assert.equal(decideCalls, 0);
});

test("ensureCandidateFits() returns ok when the candidate has no context_window_tokens", async () => {
  const noWindow: CandidateIn = { ...ollama, context_window_tokens: undefined };
  let decideCalls = 0;
  const result = await ensureCandidateFits(noWindow, candidates, 999_999, baseRequest, async () => {
    decideCalls += 1;
    return decision({});
  });

  assert.deepEqual(result, { status: "ok" });
  assert.equal(decideCalls, 0);
});

test("ensureCandidateFits() returns switched with the new candidate when decide() finds a better fit", async () => {
  const result = await ensureCandidateFits(ollama, candidates, 9000, baseRequest, async (request) => {
    assert.equal(request.task.estimated_context_tokens, 9000);
    assert.equal(request.decision_kind, "model_selection");
    return decision({ selected_candidate_id: "deepseek-v4-flash" });
  });

  assert.deepEqual(result, { status: "switched", candidate: deepseek });
});

test("ensureCandidateFits() returns exhausted when decide() finds no eligible candidate", async () => {
  const result = await ensureCandidateFits(ollama, candidates, 9000, baseRequest, async () =>
    decision({ selected_candidate_id: null })
  );

  assert.deepEqual(result, { status: "exhausted" });
});

test("ensureCandidateFits() returns exhausted when decide() requires human approval", async () => {
  const result = await ensureCandidateFits(ollama, candidates, 9000, baseRequest, async () =>
    decision({ selected_candidate_id: "deepseek-v4-flash", requires_human_approval: true })
  );

  assert.deepEqual(result, { status: "exhausted" });
});

test("ensureCandidateFits() returns exhausted when decide() selects a candidate id not in the list", async () => {
  const result = await ensureCandidateFits(ollama, candidates, 9000, baseRequest, async () =>
    decision({ selected_candidate_id: "unknown-model" })
  );

  assert.deepEqual(result, { status: "exhausted" });
});
