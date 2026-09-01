import type { AgentHandoff, AgentManifest, AgentResult } from "./contracts.ts";
import { validateHandoff, verifyAgentResult } from "./contracts.ts";

export interface SpecialistTask<T = unknown> {
  handoff: AgentHandoff<T>;
  specialist: AgentManifest;
}

export interface BoundedRuntimeOptions {
  max_agents?: number;
  max_steps_per_agent?: number;
}

/** Execute an explicitly approved set of specialists; never spawns dynamically. */
export async function runBoundedSpecialists<T, R>(
  parent: AgentManifest,
  tasks: Array<SpecialistTask<T>>,
  execute: (task: SpecialistTask<T>) => Promise<AgentResult<R>>,
  options: BoundedRuntimeOptions = {},
): Promise<AgentResult<R>[]> {
  const maxAgents = options.max_agents ?? tasks.length;
  if (!Number.isInteger(maxAgents) || maxAgents < 1 || tasks.length > maxAgents) throw new Error("agent limit exceeded");
  const results: AgentResult<R>[] = [];
  for (const task of tasks) {
    const maxSteps = options.max_steps_per_agent ?? task.specialist.maxSteps;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || task.specialist.maxSteps > maxSteps) throw new Error("specialist step limit exceeded");
    validateHandoff(task.handoff, parent, task.specialist);
    results.push(verifyAgentResult(await execute(task), task.handoff));
  }
  return results;
}
