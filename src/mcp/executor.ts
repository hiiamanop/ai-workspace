import type { ConnectorManifest, JsonSchema, ConnectorRegistry } from "./connector-registry.ts";
import { connectMcp, type McpTransportConnection } from "./transport.ts";
import type { ExternalOperation } from "../types.ts";

export interface PolicyRecheckRequest {
  connector_id: string;
  capability: string;
  operation: ExternalOperation;
  run_id?: string;
  actor_id?: string;
  organization_id?: string;
  correlation_id?: string;
  approval_granted?: boolean;
  idempotency_key?: string;
}
export interface PolicyRecheckDecision { allowed: boolean; requires_approval?: boolean; reason?: string; decision_id?: string; policy_version?: string; }
export interface McpExecutorOptions { timeoutMs?: number; retries?: number; concurrency?: number; cooldownMs?: number; connect?: (manifest: ConnectorManifest) => Promise<McpTransportConnection>; credentials?: (manifest: ConnectorManifest) => Record<string, string>; approve?: (connectorId: string, capability: string) => Promise<boolean>; authorize?: (request: PolicyRecheckRequest) => Promise<PolicyRecheckDecision>; audit?: (event: Record<string, unknown>) => void; }
type State = { active: number; failures: number; unhealthyUntil: number };
const WRITE_OPERATIONS = new Set<ExternalOperation>(["create", "update", "delete", "publish", "send", "deploy"]);

function validate(value: unknown, schema: JsonSchema | undefined, path = "input"): void {
  if (!schema) return;
  const kind = schema.type;
  if (kind === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) throw new Error(`${path}.${key} is required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(object)) if (!schema.properties?.[key]) throw new Error(`${path}.${key} is not allowed`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in object) validate(object[key], child, `${path}.${key}`);
  } else if (kind === "array") { if (!Array.isArray(value)) throw new Error(`${path} must be an array`); for (const item of value) validate(item, schema.items, path); }
  else if (kind === "string" && typeof value !== "string") throw new Error(`${path} must be a string`);
  else if (kind === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  else if (kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} must be a number`);
  else if (kind === "integer" && (typeof value !== "number" || !Number.isInteger(value))) throw new Error(`${path} must be an integer`);
  else if (kind === "null" && value !== null) throw new Error(`${path} must be null`);
}

export function createMcpExecutor(registry: ConnectorRegistry, options: McpExecutorOptions = {}) {
  const states = new Map<string, State>();
  const completed = new Map<string, unknown>();
  const timeoutMs = options.timeoutMs ?? 30_000, retries = Math.max(0, options.retries ?? 1), cooldownMs = options.cooldownMs ?? 15_000;
  const getState = (id: string) => { let state = states.get(id); if (!state) { state = { active: 0, failures: 0, unhealthyUntil: 0 }; states.set(id, state); } return state; };
  return {
    health: (id: string) => { const s = getState(id); return { healthy: s.unhealthyUntil <= Date.now(), active: s.active, failures: s.failures, unhealthyUntil: s.unhealthyUntil || undefined }; },
    async call(connectorId: string, capability: string, args: Record<string, unknown>, context: Partial<Omit<PolicyRecheckRequest, "connector_id" | "capability">> = {}): Promise<unknown> {
      const manifest = registry.get(connectorId); if (!manifest) throw new Error(`unknown connector: ${connectorId}`);
      if (!registry.allows(connectorId, capability)) throw new Error(`capability not allowed: ${connectorId}/${capability}`);
      const operation = context.operation ?? (manifest.destructiveCapabilities?.includes(capability) ? "update" : "read");
      const idempotencyKey = context.idempotency_key;
      const resultKey = idempotencyKey ? `${connectorId}:${capability}:${idempotencyKey}` : undefined;
      if (resultKey && completed.has(resultKey)) return structuredClone(completed.get(resultKey));
      const policyRequest: PolicyRecheckRequest = { ...context, connector_id: connectorId, capability, operation };
      // A write must be re-authorized immediately before execution. Missing
      // policy integration is fail-closed; registry metadata alone is not
      // authorization for an external side effect.
      if (WRITE_OPERATIONS.has(operation)) {
        if (!options.authorize) throw new Error(`policy unavailable; external ${operation} denied`);
        const decision = await options.authorize(policyRequest);
        if (!decision.allowed) throw new Error(decision.reason ?? `external ${operation} denied by policy`);
        if (decision.requires_approval && !context.approval_granted && !(await options.approve?.(connectorId, capability))) throw new Error(`approval required: ${connectorId}/${capability}`);
        options.audit?.({ type: "policy.recheck", connectorId, capability, operation, runId: context.run_id, correlationId: context.correlation_id, decisionId: decision.decision_id, policyVersion: decision.policy_version, allowed: true });
      } else if (registry.requiresApproval(connectorId, capability) && !(await options.approve?.(connectorId, capability))) {
        throw new Error(`approval required: ${connectorId}/${capability}`);
      }
      validate(args, manifest.capabilitySchemas?.[capability]?.input);
      const state = getState(connectorId); if (state.unhealthyUntil > Date.now()) throw new Error(`connector circuit open: ${connectorId}`);
      if (state.active >= (options.concurrency ?? 4)) throw new Error(`connector concurrency limit reached: ${connectorId}`);
      state.active++; options.audit?.({ type: "mcp.call", connectorId, capability });
      try {
        let last: unknown;
        for (let attempt = 0; attempt <= retries; attempt++) try {
          const connection = await (options.connect ?? ((m) => connectMcp(m, options.credentials?.(m))))(manifest);
          try {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const result = await Promise.race([connection.callTool(capability, args), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP call timeout")), timeoutMs); })]);
              validate(result, manifest.capabilitySchemas?.[capability]?.output, "output"); state.failures = 0;
              if (resultKey) completed.set(resultKey, structuredClone(result));
              options.audit?.({ type: "mcp.result", connectorId, capability, operation, runId: context.run_id, correlationId: context.correlation_id, idempotencyKey: idempotencyKey ? "present" : undefined });
              return result;
            } finally { if (timer) clearTimeout(timer); }
          } finally { await connection.close(); }
        } catch (error) { last = error; if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt)); }
        state.failures++; state.unhealthyUntil = Date.now() + cooldownMs; throw last;
      } finally { state.active--; }
    },
  };
}
