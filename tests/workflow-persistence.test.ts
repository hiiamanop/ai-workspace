import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowRun } from "../src/workflow/envelope.js";
import { WorkflowPersistence } from "../src/workflow/persistence.js";
import { WorkflowRunner } from "../src/workflow/runner.js";

test("persists workflow envelope and requeues interrupted runs on recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-workspace-workflow-"));
  const path = join(dir, "runs.db");
  const store = new WorkflowPersistence(path);
  const run = createWorkflowRun({ workflow_id: "wf-1", intent: "research", data_classification: "internal", actor_id: "actor-1" });
  const runner = new WorkflowRunner({}, store);
  runner.register(run, { maxSteps: 3 });
  runner.start(run.run_id);
  store.close();

  const recoveredStore = new WorkflowPersistence(path);
  const recoveredRunner = new WorkflowRunner({}, recoveredStore);
  const recovered = recoveredRunner.restorePersisted();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].run_id, run.run_id);
  assert.equal(recovered[0].status, "queued");
  assert.equal(recovered[0].actor_id, "actor-1");
  assert.equal(recovered[0].intent, "research");
  recoveredStore.close();
});

test("waiting approval state survives recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-workspace-workflow-"));
  const store = new WorkflowPersistence(join(dir, "runs.db"));
  const run = createWorkflowRun({ workflow_id: "wf-2", intent: "write", data_classification: "confidential" });
  run.status = "waiting_approval";
  run.approval = { required: true, granted: false, reason: "external write" };
  store.save({ run, limits: { maxSteps: 2, timeoutMs: 1000, maxRetries: 1, tokenBudget: 100, costBudgetUsd: 1 }, usage: {} });
  const recovered = store.recoverInterrupted();
  assert.equal(recovered[0].run.status, "waiting_approval");
  store.close();
});
