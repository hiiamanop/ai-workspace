import { randomUUID } from "node:crypto";

export type AgentRole = "manager" | "specialist";

export interface AgentManifest {
  id: string;
  role: AgentRole;
  version: string;
  capabilities: string[];
  allowedDataClassifications: Array<"public" | "internal" | "confidential" | "restricted">;
  maxSteps: number;
}

export interface AgentHandoff<T = unknown> {
  handoff_id: string;
  run_id: string;
  parent_agent_id: string;
  specialist_agent_id: string;
  capability: string;
  input: T;
  data_classification: AgentManifest["allowedDataClassifications"][number];
  created_at: string;
  expires_at?: string;
}

export interface AgentResult<T = unknown> {
  handoff_id: string;
  agent_id: string;
  status: "completed" | "failed";
  output?: T;
  error?: { code: string; message: string };
  evidence?: Array<{ source: string; claim: string }>;
  completed_at: string;
}

export function createHandoff<T>(input: Omit<AgentHandoff<T>, "handoff_id" | "created_at">): AgentHandoff<T> {
  return { ...input, handoff_id: randomUUID(), created_at: new Date().toISOString() };
}

export function validateHandoff<T>(handoff: AgentHandoff<T>, parent: AgentManifest, specialist: AgentManifest): void {
  if (parent.role !== "manager") throw new Error("handoff parent must be a manager agent");
  if (specialist.role !== "specialist" || specialist.id !== handoff.specialist_agent_id) throw new Error("handoff specialist is not approved");
  if (!specialist.capabilities.includes(handoff.capability)) throw new Error("handoff capability is not approved");
  if (!specialist.allowedDataClassifications.includes(handoff.data_classification)) throw new Error("handoff data classification is not approved");
  if (handoff.expires_at && Date.parse(handoff.expires_at) <= Date.now()) throw new Error("handoff has expired");
}

export function verifyAgentResult<T>(result: AgentResult<T>, handoff: AgentHandoff<T>): AgentResult<T> {
  if (result.handoff_id !== handoff.handoff_id) throw new Error("agent result does not match handoff");
  if (result.status === "completed" && result.output === undefined) throw new Error("completed agent result requires output");
  return result;
}
