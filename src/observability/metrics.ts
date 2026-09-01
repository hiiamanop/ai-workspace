export interface MetricEvent {
  type: "workflow" | "policy" | "approval" | "mcp" | "model";
  outcome: "completed" | "failed" | "denied" | "approved" | "rejected" | "started";
  latency_ms?: number;
  cost_usd?: number;
  retry?: boolean;
  agent_id?: string;
}

export interface MetricsSnapshot {
  total: number;
  completed: number;
  failed: number;
  denied: number;
  approvals: { approved: number; rejected: number; pending: number };
  retries: number;
  latency_ms: { count: number; average: number; p95: number };
  cost_usd: number;
  agents: Record<string, { total: number; completed: number; failed: number; denied: number; retries: number; latency_ms: number; cost_usd: number }>;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(p * ordered.length) - 1)];
}

export function createMetricsCollector() {
  const events: MetricEvent[] = [];
  return {
    record(event: MetricEvent): void { events.push({ ...event }); },
    snapshot(): MetricsSnapshot {
      const latency = events.flatMap((event) => typeof event.latency_ms === "number" ? [event.latency_ms] : []);
      const agents: MetricsSnapshot["agents"] = {};
      for (const event of events.filter((item) => item.agent_id)) {
        const id = event.agent_id as string;
        const item = agents[id] ??= { total: 0, completed: 0, failed: 0, denied: 0, retries: 0, latency_ms: 0, cost_usd: 0 };
        item.total++;
        if (event.outcome === "completed") item.completed++;
        if (event.outcome === "failed") item.failed++;
        if (event.outcome === "denied" || event.outcome === "rejected") item.denied++;
        if (event.retry) item.retries++;
        item.latency_ms += event.latency_ms ?? 0;
        item.cost_usd += event.cost_usd ?? 0;
      }
      return {
        total: events.length,
        completed: events.filter((event) => event.outcome === "completed").length,
        failed: events.filter((event) => event.outcome === "failed").length,
        denied: events.filter((event) => event.outcome === "denied" || event.outcome === "rejected").length,
        approvals: {
          approved: events.filter((event) => event.type === "approval" && event.outcome === "approved").length,
          rejected: events.filter((event) => event.type === "approval" && event.outcome === "rejected").length,
          pending: events.filter((event) => event.type === "approval" && event.outcome === "started").length,
        },
        retries: events.filter((event) => event.retry).length,
        latency_ms: { count: latency.length, average: latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : 0, p95: percentile(latency, 0.95) },
        cost_usd: events.reduce((sum, event) => sum + (event.cost_usd ?? 0), 0),
        agents,
      };
    },
    clear(): void { events.length = 0; },
  };
}

export const defaultMetricsCollector = createMetricsCollector();
