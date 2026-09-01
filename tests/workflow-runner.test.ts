import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowRun } from "../src/workflow/envelope.js";
import { WorkflowError, WorkflowRunner } from "../src/workflow/runner.js";

function runWith(runner: WorkflowRunner) {
  return runner.register(createWorkflowRun({ workflow_id: "wf", intent: "research", data_classification: "public" }));
}

test("runner enforces bounded transitions and max steps", () => {
  const runner = new WorkflowRunner({ maxSteps: 1 });
  const run = runWith(runner);
  assert.equal(runner.start(run.run_id).status, "running");
  runner.addStep(run.run_id, { capability: "search", operation: "read", requires_approval: false });
  assert.throws(() => runner.addStep(run.run_id, { capability: "scrape", operation: "read", requires_approval: false }), (error: unknown) => error instanceof WorkflowError && error.code === "MAX_STEPS_EXCEEDED");
  assert.equal(runner.complete(run.run_id, { status: "passed" }).status, "completed");
  assert.throws(() => runner.start(run.run_id), /cannot start/);
});

test("runner retries a failed step and preserves successful result", async () => {
  const runner = new WorkflowRunner({ maxRetries: 1, timeoutMs: 500 });
  const run = runWith(runner);
  runner.start(run.run_id);
  const step = runner.addStep(run.run_id, { capability: "search", operation: "read", requires_approval: false }).steps[0];
  let calls = 0;
  await assert.rejects(() => runner.executeStep(run.run_id, step.id, async () => { calls++; throw new Error("temporary"); }), (error: unknown) => error instanceof WorkflowError && error.code === "STEP_FAILED");
  assert.equal(runner.get(run.run_id).status, "running");
  const result = await runner.executeStep(run.run_id, step.id, async () => { calls++; return { output: "ok", usage: { tokens: 5, costUsd: 0.01 } }; });
  assert.equal(result.output, "ok");
  assert.equal(calls, 2);
  assert.equal(runner.get(run.run_id).steps[0].status, "completed");
});

test("runner fails closed when token or cost budget is exhausted", async () => {
  const runner = new WorkflowRunner({ tokenBudget: 10, costBudgetUsd: 1 });
  const run = runWith(runner); runner.start(run.run_id);
  const step = runner.addStep(run.run_id, { capability: "model", operation: "read", requires_approval: false }).steps[0];
  await assert.rejects(() => runner.executeStep(run.run_id, step.id, async () => ({ output: null, usage: { tokens: 11, costUsd: 0.1 } })), (error: unknown) => error instanceof WorkflowError && error.code === "TOKEN_BUDGET_EXCEEDED");
  assert.equal(runner.get(run.run_id).status, "failed");
  assert.equal(runner.get(run.run_id).error?.code, "TOKEN_BUDGET_EXCEEDED");
});

test("cancel is idempotent and resume returns a run to queued", () => {
  const runner = new WorkflowRunner(); const run = runWith(runner);
  runner.start(run.run_id);
  assert.equal(runner.cancel(run.run_id).status, "cancelled");
  assert.equal(runner.cancel(run.run_id).status, "cancelled");
  assert.equal(runner.resume(run.run_id).status, "queued");
  assert.equal(runner.resume(run.run_id).status, "queued");
});

test("final verification failure produces a structured terminal error", () => {
  const runner = new WorkflowRunner(); const run = runWith(runner); runner.start(run.run_id);
  const failed = runner.complete(run.run_id, { status: "failed", message: "evidence incomplete" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "VERIFICATION_FAILED");
});
