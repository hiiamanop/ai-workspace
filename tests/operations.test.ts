import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";
import { createOperationsStore } from "../src/operations-store.ts";

test("operations endpoints expose safe empty envelopes and filters", async () => {
  const store = createOperationsStore();
  store.addAudit({ event_id: "e1", event_type: "mcp.call", run_id: null, correlation_id: "c1", actor_id: "a1", policy_decision_id: null, policy_version: null, occurred_at: new Date().toISOString(), latency_ms: 1, outcome: "ok", metadata: { api_key: "hidden", result: "safe" } });
  const server = createServer(async () => ({}), undefined, undefined, undefined, undefined, store); server.listen(0);
  const base = `http://localhost:${(server.address() as { port: number }).port}`;
  const [status, audit, metrics] = await Promise.all([fetch(`${base}/api/operations/status`), fetch(`${base}/api/operations/audit?correlation_id=c1`), fetch(`${base}/api/operations/metrics`)]);
  assert.equal(status.status, 200); assert.equal((await status.json()).services.length, 0);
  const auditBody = await audit.json(); assert.equal(auditBody.total, 1); assert.deepEqual(auditBody.events[0].metadata, { result: "safe" });
  assert.deepEqual(await metrics.json(), { available: false }); server.close();
});
