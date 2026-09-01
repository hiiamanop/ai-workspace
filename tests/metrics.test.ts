import test from "node:test";
import assert from "node:assert/strict";
import { createMetricsCollector } from "../src/observability/metrics.ts";

test("metrics collector aggregates outcomes, approvals, retries, latency and cost", () => {
  const metrics = createMetricsCollector();
  metrics.record({ type: "workflow", outcome: "completed", latency_ms: 10, cost_usd: 0.2 });
  metrics.record({ type: "workflow", outcome: "failed", latency_ms: 30, retry: true });
  metrics.record({ type: "policy", outcome: "denied" });
  metrics.record({ type: "approval", outcome: "approved" });
  metrics.record({ type: "approval", outcome: "started" });
  assert.deepEqual(metrics.snapshot(), { total: 5, completed: 1, failed: 1, denied: 1, approvals: { approved: 1, rejected: 0, pending: 1 }, retries: 1, latency_ms: { count: 2, average: 20, p95: 30 }, cost_usd: 0.2 });
});
