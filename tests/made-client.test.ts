import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/made-client.ts";
import type { DecideRequest, DecideResponse } from "../src/types.ts";

test("decide() posts the request to MADE_URL/decide and returns the parsed response", async () => {
  const fakeResponse: DecideResponse = {
    decision_id: "abc-123",
    selected_candidate_id: "gemma4-12b",
    requires_human_approval: false,
    ranking: [{ id: "gemma4-12b", score: 0.9 }],
    excluded: [],
    technique_used: "topsis",
    policy_version: "1",
  };

  let capturedUrl = "";
  let capturedBody: unknown = null;
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(fakeResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const request: DecideRequest = {
    task: { type: "chat", data_classification: "internal" },
    org: { budget_remaining_usd: 10, region: "us" },
    decision_kind: "model_selection",
    candidates: [
      { id: "gemma4-12b", vendor: "ollama-local", kind: "model", cost_per_1k_tokens: 0, scores: { cost: 0, quality: 0.75, latency: 9000, business_risk: 0.1 } },
    ],
    policy_set: "default",
  };

  const result = await decide(request, "http://made.test", fakeFetch);

  assert.equal(capturedUrl, "http://made.test/decide");
  assert.deepEqual(capturedBody, request);
  assert.deepEqual(result, fakeResponse);
});

test("decide() throws on non-200 response", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response("boom", { status: 503 });

  await assert.rejects(
    () =>
      decide(
        {
          task: { type: "chat", data_classification: "internal" },
          org: { budget_remaining_usd: 10, region: "us" },
          decision_kind: "model_selection",
          candidates: [],
          policy_set: "default",
        },
        "http://made.test",
        fakeFetch
      ),
    /MADE \/decide returned 503/
  );
});
