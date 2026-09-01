import assert from "node:assert/strict";
import test from "node:test";
import { addWorkflowStep, createWorkflowRun } from "../src/workflow/envelope.js";

test("workflow run envelope creates an auditable run and appends bounded steps", () => {
    const run = createWorkflowRun({ workflow_id: "research", intent: "product_research", data_classification: "public" });
    const updated = addWorkflowStep(run, { capability: "web_search", operation: "read", requires_approval: false });
    assert.ok(updated.run_id);
    assert.equal(updated.steps[0].status, "pending");
    assert.equal(updated.steps[0].capability, "web_search");
  });

test("workflow run envelope does not append steps after terminal state", () => {
    const run = { ...createWorkflowRun({ workflow_id: "x", intent: "x", data_classification: "public" }), status: "completed" as const };
    assert.throws(() => addWorkflowStep(run, { capability: "x", operation: "read", requires_approval: false }), /completed/);
  });
