export interface MetricEvent {
  type: "workflow" | "policy" | "approval" | "mcp" | "model";
  outcome: "completed" | "failed" | "denied" | "approved" | "rejected" | "started";
  latency_ms?: number;
  cost_usd?: number;
  retry?: boolean;
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
      };
    },
    clear(): void { events.length = 0; },
  };
}

export const defaultMetricsCollector = createMetricsCollector();
