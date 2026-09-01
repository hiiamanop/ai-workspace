import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectorRegistry, type ConnectorManifest } from "../../src/mcp/connector-registry.ts";
import { createMcpExecutor } from "../../src/mcp/executor.ts";

const manifest: ConnectorManifest = {
  id: "fixture", version: "1.0.0", description: "test MCP", mcpServer: "fixture",
  capabilities: ["echo", "write"], approvalRequiredCapabilities: ["write"],
  capabilitySchemas: { echo: { input: { type: "object", required: ["message"], properties: { message: { type: "string" } }, additionalProperties: false } } },
};
const connection = (result: unknown, delay = 0) => ({ callTool: async () => { if (delay) await new Promise((r) => setTimeout(r, delay)); return result; }, close: async () => {} });

test("executor validates schema and invokes generic fixture transport", async () => {
  const executor = createMcpExecutor(createConnectorRegistry([manifest]), { connect: async () => connection({ ok: true }) });
  assert.deepEqual(await executor.call("fixture", "echo", { message: "hello" }), { ok: true });
  await assert.rejects(() => executor.call("fixture", "echo", { message: 2 }), /must be a string/);
});

test("executor enforces approval, retries, and opens circuit after failure", async () => {
  let attempts = 0;
  const executor = createMcpExecutor(createConnectorRegistry([manifest]), { retries: 1, cooldownMs: 10_000, connect: async () => { attempts++; throw new Error("offline"); } });
  await assert.rejects(() => executor.call("fixture", "write", {}), /approval required/);
  const approved = createMcpExecutor(createConnectorRegistry([manifest]), { retries: 1, cooldownMs: 10_000, approve: async () => true, connect: async () => { attempts++; throw new Error("offline"); } });
  await assert.rejects(() => approved.call("fixture", "write", {}), /offline/);
  assert.equal(attempts, 2);
  assert.equal(approved.health("fixture").healthy, false);
  await assert.rejects(() => approved.call("fixture", "write", {}), /circuit open/);
});

test("executor applies timeout and concurrency limit", async () => {
  const registry = createConnectorRegistry([{ ...manifest, approvalRequiredCapabilities: [] }]);
  const executor = createMcpExecutor(registry, { timeoutMs: 5, concurrency: 1, connect: async () => connection({ ok: true }, 30) });
  const first = executor.call("fixture", "echo", { message: "x" });
  await assert.rejects(() => executor.call("fixture", "echo", { message: "y" }), /concurrency limit/);
  await assert.rejects(() => first, /timeout/);
});
