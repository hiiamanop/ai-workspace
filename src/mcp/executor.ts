import type { AuditSink } from "../audit-log.ts";
import type { WorkflowOperation } from "../workflow/envelope.ts";
import type { ConnectorRegistry } from "./connector-registry.ts";

export interface McpCall {
  connector_id: string;
  capability: string;
  operation: WorkflowOperation;
  args: Record<string, unknown>;
  scopes?: string[];
  approval_granted?: boolean;
  run_id?: string;
  actor_id?: string;
}

export interface McpTransport {
  call(input: { server: string; capability: string; operation: WorkflowOperation; args: Record<string, unknown>; signal: AbortSignal }): Promise<unknown>;
}

export function createMcpExecutor(registry: ConnectorRegistry, transport: McpTransport, options: { timeoutMs?: number; audit?: AuditSink } = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return async (call: McpCall): Promise<unknown> => {
    const manifest = registry.get(call.connector_id);
    options.audit?.record({ type: "mcp_call", outcome: "started", run_id: call.run_id, actor_id: call.actor_id, connector_id: call.connector_id, capability: call.capability });
    if (!manifest || !registry.allows(call.connector_id, call.capability)) {
      options.audit?.record({ type: "mcp_call", outcome: "denied", run_id: call.run_id, actor_id: call.actor_id, connector_id: call.connector_id, capability: call.capability, metadata: { reason: "capability_not_allowlisted" } });
      throw new Error("MCP capability denied by policy");
    }
    const required = new Set(manifest.requiredScopes ?? []);
    const supplied = new Set(call.scopes ?? []);
    if ([...required].some((scope) => !supplied.has(scope))) {
      options.audit?.record({ type: "mcp_call", outcome: "denied", run_id: call.run_id, actor_id: call.actor_id, connector_id: call.connector_id, capability: call.capability, metadata: { reason: "scope_missing" } });
      throw new Error("MCP scope requirement not satisfied");
    }
    if (registry.requiresApproval(call.connector_id, call.capability) && !call.approval_granted) {
      options.audit?.record({ type: "mcp_call", outcome: "denied", run_id: call.run_id, actor_id: call.actor_id, connector_id: call.connector_id, capability: call.capability, metadata: { reason: "approval_required" } });
      throw new Error("MCP capability requires approval");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await transport.call({ server: manifest.mcpServer, capability: call.capability, operation: call.operation, args: call.args, signal: controller.signal });
      options.audit?.record({ type: "mcp_call", outcome: "completed", run_id: call.run_id, actor_id: call.actor_id, connector_id: call.connector_id, capability: call.capability });
      return result;
    } catch (error) {
      options.audit?.record({ type: "mcp_call", outcome: "failed", run_id: call.run_id, actor_id: call.actor_id, connector_id: call.connector_id, capability: call.capability, metadata: { reason: error instanceof Error ? error.message : "unknown" } });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
