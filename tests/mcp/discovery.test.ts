import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectorRegistry, type ConnectorManifest } from "../../src/mcp/connector-registry.ts";
import { createConnectorDiscovery } from "../../src/mcp/discovery.ts";

const manifest: ConnectorManifest = {
  id: "fixture",
  version: "1.0.0",
  description: "A fixture connector",
  mcpServer: "fixture-server",
  capabilities: ["read", "write"],
  requiredScopes: ["fixture.read"],
  destructiveCapabilities: ["write"],
  capabilitySchemas: { read: { input: { type: "object" } } },
};

test("public connector listing does not expose MCP endpoint or credentials", () => {
  const discovery = createConnectorDiscovery(createConnectorRegistry([manifest]));
  const item = discovery.list()[0];
  assert.deepEqual(item.capabilities, ["read", "write"]);
  assert.equal(item.transport, "unspecified");
  assert.equal("mcpServer" in item, false);
  assert.equal("credentials" in item, false);
});
test("capability discovery is intersected with manifest allowlist", async () => {
  const discovery = createConnectorDiscovery(createConnectorRegistry([manifest]), {
    discover: async () => [{ name: "read", description: "safe" }, { name: "delete", description: "not declared" }],
  });
  const capabilities = await discovery.discover("fixture");
  assert.deepEqual(capabilities.map((capability) => capability.name), ["read"]);
});

test("health and readiness expose executor state without probing tools", async () => {
  const discovery = createConnectorDiscovery(createConnectorRegistry([manifest]), {
    health: () => ({ healthy: true, active: 0, failures: 0 }),
  });
  const health = await discovery.health("fixture");
  assert.equal(health.status, "healthy");
  assert.equal(health.capabilities[0].name, "read");
  const readiness = await discovery.readiness();
  assert.equal(readiness.ready, true);
});
