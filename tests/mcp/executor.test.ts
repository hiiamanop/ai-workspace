import test from "node:test";
import assert from "node:assert/strict";
import { createMcpExecutor } from "../../src/mcp/executor.ts";
import { createConnectorRegistry } from "../../src/mcp/connector-registry.ts";
import { createAuditSink } from "../../src/audit-log.ts";

test("MCP executor enforces capability, scope and approval", async () => {
  const registry = createConnectorRegistry([{ id: "figma", version: "1", description: "", mcpServer: "figma-mcp", capabilities: ["read_file", "publish"], requiredScopes: ["files:read"], approvalRequiredCapabilities: ["publish"] }]);
  const audit = createAuditSink();
  const executor = createMcpExecutor(registry, { call: async (input) => ({ server: input.server, ok: true }) }, { audit });
  await assert.rejects(() => executor({ connector_id: "figma", capability: "read_file", operation: "read", args: {} }), /scope/);
  await assert.rejects(() => executor({ connector_id: "figma", capability: "publish", operation: "publish", args: {}, scopes: ["files:read"] }), /approval/);
  assert.deepEqual(await executor({ connector_id: "figma", capability: "read_file", operation: "read", args: {}, scopes: ["files:read"] }), { server: "figma-mcp", ok: true });
  assert.equal(audit.list().some((e) => e.outcome === "completed"), true);
});
