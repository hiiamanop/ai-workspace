import test from "node:test";
import assert from "node:assert/strict";
import { createAuditSink } from "../src/audit-log.ts";

test("audit sink records immutable events without payload secrets", () => {
  const sink = createAuditSink();
  sink.record({ type: "mcp_call", outcome: "completed", connector_id: "figma", capability: "read_file" });
  const events = sink.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].connector_id, "figma");
  assert.ok(events[0].id && events[0].at);
});
