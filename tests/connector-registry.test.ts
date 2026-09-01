import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectorRegistry, type ConnectorManifest } from "../src/mcp/connector-registry.ts";

const research: ConnectorManifest = {
  id: "research",
  version: "0.1.0",
  description: "Read-only web research",
  mcpServer: "mcp-research",
  capabilities: ["search", "scrape"],
};

test("connector registry validates and exposes generic capabilities", () => {
  const registry = createConnectorRegistry([research]);
  assert.equal(registry.allows("research", "search"), true);
  assert.equal(registry.allows("research", "publish"), false);
  assert.equal(registry.list()[0].id, "research");
});

test("approval metadata must reference a declared capability", () => {
  assert.throws(() => createConnectorRegistry([{ ...research, approvalRequiredCapabilities: ["publish"] }]), /undeclared capability/);
});

test("registry rejects duplicate ids and protects stored manifests", () => {
  const registry = createConnectorRegistry([research]);
  assert.throws(() => registry.register(research), /already registered/);
  const listed = registry.list();
  listed[0].capabilities.push("publish");
  assert.equal(registry.allows("research", "publish"), false);
});
