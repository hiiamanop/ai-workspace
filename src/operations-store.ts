import type { MetricsSnapshot } from "./observability/metrics.ts";
import type { ConnectorReadiness, PublicConnector } from "./mcp/discovery.ts";

export interface OperationRun {
  workflow_id: string; run_id: string; status: string; actor_id: string | null;
  intent: string | null; started_at: string | null; updated_at: string;
  duration_ms: number; step_count: number; cost_usd: number; error_code: string | null;
  steps?: unknown[];
}
export interface Approval { approval_id: string; run_id: string; capability: string; operation: string; requested_by: string | null; reason: string; expires_at: string | null; status: string; }
export interface AuditEvent { event_id: string; event_type: string; run_id: string | null; correlation_id: string | null; actor_id: string | null; policy_decision_id: string | null; policy_version: string | null; occurred_at: string; latency_ms: number | null; outcome: string; metadata: Record<string, unknown>; }

const SECRET = /token|secret|password|api[_-]?key|credential|authorization/i;
function safeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeMetadata);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !SECRET.test(k)).map(([k, v]) => [k, safeMetadata(v)]));
  return value;
}

export function createOperationsStore() {
  const runs: OperationRun[] = [], approvals: Approval[] = [], audit: AuditEvent[] = [];
  let status: Record<string, unknown> = { generated_at: new Date().toISOString(), services: [] };
  let connectors: { list: () => PublicConnector[]; readiness: () => Promise<ConnectorReadiness> } | undefined;
  let metrics: (() => MetricsSnapshot) | undefined;
  return {
    setStatus(value: Record<string, unknown>) { status = { ...value, generated_at: new Date().toISOString() }; },
    setConnectors(value: typeof connectors) { connectors = value; },
    setMetrics(value: typeof metrics) { metrics = value; },
    addRun(run: OperationRun) { runs.push({ ...run }); },
    addApproval(approval: Approval) { approvals.push({ ...approval }); },
    addAudit(event: AuditEvent) { audit.push({ ...event, metadata: safeMetadata(event.metadata) as Record<string, unknown> }); },
    listRuns(limit = 25, state?: string) { const filtered = state ? runs.filter((r) => r.status === state) : runs; return { runs: filtered.slice(-Math.min(Math.max(limit, 1), 100)).reverse(), total: filtered.length }; },
    getRun(id: string) { return runs.find((r) => r.run_id === id); },
    listApprovals(state = "pending") { const filtered = state ? approvals.filter((a) => a.status === state) : approvals; return { approvals: filtered, total: filtered.length }; },
    listAudit(limit = 50, filters: { actor_id?: string; organization_id?: string; correlation_id?: string } = {}) { const filtered = audit.filter((e) => (!filters.actor_id || e.actor_id === filters.actor_id) && (!filters.correlation_id || e.correlation_id === filters.correlation_id)); return { events: filtered.slice(-Math.min(Math.max(limit, 1), 200)).reverse(), total: filtered.length }; },
    status: () => status,
    connectors: () => connectors,
    metrics: () => metrics?.(),
  };
}
export type OperationsStore = ReturnType<typeof createOperationsStore>;
export const defaultOperationsStore = createOperationsStore();
