import { test } from "node:test";
import assert from "node:assert/strict";
import { recheckExternalOperation } from "../src/policy-gate.ts";

test("policy gate sends a typed operation and accepts only the exact connector capability", async () => {
  let request: any;
  const result = await recheckExternalOperation({ decide: async (input) => {
    request = input;
    return { decision_id: "decision-1", selected_candidate_id: "drive/export", requires_human_approval: false, ranking: [{ id: "drive/export", score: 1 }], excluded: [], technique_used: "weighted_sum", policy_version: "policy-1" };
  } }, { connector_id: "drive", capability: "export", operation: "create", run_id: "run-1", approval_granted: true, idempotency_key: "idem-1" });
  assert.equal(result.allowed, true);
  assert.equal(request.task.operation, "create");
  assert.equal(request.task.run_id, "run-1");
  assert.equal(request.candidates[0].connector_id, "drive");
});

test("policy gate fails closed when MADE is unavailable", async () => {
  const result = await recheckExternalOperation({ decide: async () => { throw new Error("503"); } }, { connector_id: "drive", capability: "delete", operation: "delete" });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /policy unavailable/);
});
