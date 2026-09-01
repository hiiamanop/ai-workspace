import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFailureScenarios, failureInjector } from "../src/evaluation.ts";

test("failure matrix covers model, policy, transport, and connector boundaries", async () => {
  const failing = (name: string) => failureInjector(async () => `${name}-ok`, () => true, `${name} unavailable`);
  const report = await evaluateFailureScenarios([
    { id: "model", run: () => failing("model")(), expectedError: /model unavailable/ },
    { id: "policy", run: () => failing("policy")(), expectedError: /policy unavailable/ },
    { id: "transport", run: () => failing("transport")(), expectedError: /transport unavailable/ },
    { id: "connector", run: () => failing("connector")(), expectedError: /connector unavailable/ },
  ]);
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 4);
});
