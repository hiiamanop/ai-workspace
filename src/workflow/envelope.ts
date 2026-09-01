import { randomUUID } from "node:crypto";

export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "blocked";
export type WorkflowStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
export type WorkflowOperation = "read" | "draft" | "create" | "update" | "delete" | "publish" | "send" | "deploy";

export interface WorkflowStep {
  id: string;
  capability: string;
  connector_id?: string;
  operation: WorkflowOperation;
  status: WorkflowStepStatus;
  requires_approval: boolean;
  error?: { code: string; message: string };
}

export interface WorkflowRunEnvelope {
  run_id: string;
  workflow_id: string;
  status: WorkflowStatus;
  created_at: string;
  updated_at: string;
  actor_id?: string;
  intent: string;
  data_classification: "public" | "internal" | "confidential" | "restricted";
  selected_model?: string;
  steps: WorkflowStep[];
  approval?: { required: boolean; granted: boolean; reason?: string; granted_at?: string };
  policy?: { decision_id?: string; policy_version?: string };
}

export function createWorkflowRun(input: Pick<WorkflowRunEnvelope, "workflow_id" | "intent" | "data_classification"> & Partial<Pick<WorkflowRunEnvelope, "actor_id">>): WorkflowRunEnvelope {
  const now = new Date().toISOString();
  return { ...input, run_id: randomUUID(), status: "queued", created_at: now, updated_at: now, steps: [], approval: { required: false, granted: false } };
}

export function addWorkflowStep(run: WorkflowRunEnvelope, step: Omit<WorkflowStep, "id" | "status">): WorkflowRunEnvelope {
  if (run.status === "completed" || run.status === "cancelled") throw new Error(`cannot add a step to ${run.status} run`);
  return { ...run, updated_at: new Date().toISOString(), steps: [...run.steps, { ...step, id: randomUUID(), status: "pending" }] };
}
