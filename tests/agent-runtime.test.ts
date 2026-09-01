import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandoff, validateHandoff, verifyAgentResult } from "../src/agents/contracts.ts";
import { createControlledAction } from "../src/controlled-actions.ts";
import { evaluateCases, failureInjector } from "../src/evaluation.ts";

test("agent handoff is restricted to manifest capabilities and classification", () => {
  const manager = { id: "manager", role: "manager" as const, version: "1", capabilities: [], allowedDataClassifications: ["internal"] as const, maxSteps: 10 };
  const specialist = { id: "search", role: "specialist" as const, version: "1", capabilities: ["search"], allowedDataClassifications: ["public", "internal"] as const, maxSteps: 3 };
  const handoff = createHandoff({ run_id: "r1", parent_agent_id: manager.id, specialist_agent_id: specialist.id, capability: "search", input: { q: "x" }, data_classification: "internal" });
  validateHandoff(handoff, manager, specialist);
  assert.throws(() => verifyAgentResult({ handoff_id: "wrong", agent_id: "search", status: "completed", completed_at: new Date().toISOString() }, handoff), /does not match/);
});

test("controlled actions support approval, dry-run, verification and idempotency", async () => {
  let calls = 0;
  const action = createControlledAction({ execute: async () => { calls++; return { ok: true }; }, verify: async () => ({ status: "passed" as const }), compensate: () => ({ capability: "undo" }) });
  const request = { operation: "publish" as const, connector_id: "fixture", capability: "publish", input: {}, run_id: "r1", idempotency_key: "k", approval_granted: true };
  assert.equal((await action.run({ ...request, dry_run: true })).status, "simulated");
  assert.equal((await action.run(request)).verification?.status, "passed");
  assert.equal((await action.run(request)).status, "executed");
  assert.equal(calls, 1);
  assert.equal((await action.run({ ...request, approval_granted: false, idempotency_key: "new" })).status, "blocked");
});

test("evaluation and deterministic failure injection produce stable reports", async () => {
  let calls = 0;
  const fn = failureInjector(async (value: number) => value * 2, (call) => call === 2);
  const report = await evaluateCases([{ id: "ok", input: 2, expected: 4, run: fn }, { id: "failure", input: 3, expected: 6, run: fn }]);
  assert.deepEqual({ total: report.total, passed: report.passed, failed: report.failed }, { total: 2, passed: 1, failed: 1 });
  void calls;
});
