import type { ExternalOperation } from "./types.ts";

export const EXTERNAL_OPERATIONS: readonly ExternalOperation[] = ["read", "draft", "create", "update", "delete", "publish", "send", "deploy"];
export const SIDE_EFFECT_OPERATIONS = new Set<ExternalOperation>(["create", "update", "delete", "publish", "send", "deploy"]);

export interface ActionRequest<T = Record<string, unknown>> {
  operation: ExternalOperation;
  connector_id: string;
  capability: string;
  input: T;
  run_id: string;
  idempotency_key?: string;
  dry_run?: boolean;
  approval_granted?: boolean;
}
export interface ActionResult<T = unknown> {
  status: "executed" | "simulated" | "blocked";
  operation: ExternalOperation;
  connector_id: string;
  capability: string;
  output?: T;
  idempotency_key?: string;
  verification?: { status: "pending" | "passed" | "failed"; message?: string };
  compensation?: { available: boolean; capability?: string; reason?: string };
  reason?: string;
}
export interface ControlledActionOptions<T, R> {
  execute: (request: ActionRequest<T>) => Promise<R>;
  verify?: (output: R, request: ActionRequest<T>) => Promise<{ status: "passed" | "failed"; message?: string }>;
  compensate?: (request: ActionRequest<T>, output: R) => { capability?: string; reason?: string } | undefined;
  authorize?: (request: ActionRequest<T>) => Promise<{ allowed: boolean; requires_approval?: boolean; reason?: string }>;
}

export function createControlledAction<T, R>(options: ControlledActionOptions<T, R>) {
  const completed = new Map<string, ActionResult<R>>();
  return {
    async run(request: ActionRequest<T>): Promise<ActionResult<R>> {
      if (!(EXTERNAL_OPERATIONS as readonly string[]).includes(request.operation)) throw new Error(`unsupported external operation: ${request.operation}`);
      if (SIDE_EFFECT_OPERATIONS.has(request.operation) && !request.idempotency_key) throw new Error("idempotency_key is required for external side effects");
      const key = request.idempotency_key ? `${request.connector_id}:${request.capability}:${request.idempotency_key}` : undefined;
      if (key && completed.has(key)) return structuredClone(completed.get(key)!);
      if (options.authorize) {
        const decision = await options.authorize(request);
        if (!decision.allowed) return { status: "blocked", operation: request.operation, connector_id: request.connector_id, capability: request.capability, idempotency_key: request.idempotency_key, reason: decision.reason ?? "policy denied action" };
        if (decision.requires_approval && !request.approval_granted) return { status: "blocked", operation: request.operation, connector_id: request.connector_id, capability: request.capability, idempotency_key: request.idempotency_key, reason: "approval required" };
      } else if (SIDE_EFFECT_OPERATIONS.has(request.operation) && !request.approval_granted) {
        return { status: "blocked", operation: request.operation, connector_id: request.connector_id, capability: request.capability, idempotency_key: request.idempotency_key, reason: "approval required" };
      }
      if (request.dry_run && SIDE_EFFECT_OPERATIONS.has(request.operation)) return { status: "simulated", operation: request.operation, connector_id: request.connector_id, capability: request.capability, idempotency_key: request.idempotency_key, verification: { status: "pending", message: "dry-run did not execute an external side effect" } };
      const output = await options.execute(request);
      const verification = options.verify ? await options.verify(output, request) : { status: "pending" as const };
      const result: ActionResult<R> = { status: "executed", operation: request.operation, connector_id: request.connector_id, capability: request.capability, output, idempotency_key: request.idempotency_key, verification, compensation: { available: Boolean(options.compensate), ...(options.compensate ? options.compensate(request, output) : {}) } };
      if (key) completed.set(key, structuredClone(result));
      return result;
    },
  };
}
