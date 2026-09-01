import type { ConnectorManifest, ConnectorRegistry, JsonSchema } from "./connector-registry.ts";

/** Public, credential-free representation of an MCP connector. */
export interface PublicConnector {
  id: string;
  version: string;
  description: string;
  transport: "stdio" | "streamable-http" | "unspecified";
  capabilities: string[];
  required_scopes: string[];
  approval_required_capabilities: string[];
  destructive_capabilities: string[];
}
export interface DiscoveredCapability {
  name: string;
  description?: string;
  input_schema?: JsonSchema;
  output_schema?: JsonSchema;
}

export type ConnectorHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface ConnectorHealth {
  connector_id: string;
  status: ConnectorHealthStatus;
  active: number;
  failures: number;
  checked_at: string;
  next_retry_at?: string;
  capabilities: DiscoveredCapability[];
}

export interface ConnectorReadiness {
  ready: boolean;
  checked_at: string;
  connectors: ConnectorHealth[];
}

export interface DiscoveryOptions {
  /** Discovery is injected by the MCP boundary; credentials never cross this API. */
  discover?: (manifest: ConnectorManifest) => Promise<DiscoveredCapability[]>;
  health?: (connectorId: string) => { healthy: boolean; active: number; failures: number; unhealthyUntil?: number };
}

function publicManifest(manifest: ConnectorManifest): PublicConnector {
  return {
    id: manifest.id,
    version: manifest.version,
    description: manifest.description,
    transport: manifest.transport?.type ?? "unspecified",
    capabilities: [...manifest.capabilities],
    required_scopes: [...(manifest.requiredScopes ?? [])],
    approval_required_capabilities: [...(manifest.approvalRequiredCapabilities ?? [])],
    destructive_capabilities: [...(manifest.destructiveCapabilities ?? [])],
  };
}

function manifestCapabilities(manifest: ConnectorManifest): DiscoveredCapability[] {
  return manifest.capabilities.map((name) => ({
    name,
    input_schema: manifest.capabilitySchemas?.[name]?.input,
    output_schema: manifest.capabilitySchemas?.[name]?.output,
  }));
}

/**
 * Connector discovery service. Server-reported capabilities are intersected
 * with the manifest allowlist so discovery can never authorize a new action.
 */
export function createConnectorDiscovery(registry: ConnectorRegistry, options: DiscoveryOptions = {}) {
  const discovered = new Map<string, DiscoveredCapability[]>();

  return {
    list(): PublicConnector[] {
      return registry.list().map(publicManifest);
    },

    async discover(id: string): Promise<DiscoveredCapability[]> {
      const manifest = registry.get(id);
      if (!manifest) throw new Error(`unknown connector: ${id}`);
      const reported = options.discover ? await options.discover(structuredClone(manifest)) : manifestCapabilities(manifest);
      const allowed = new Set(manifest.capabilities);
      const safe = reported
        .filter((capability) => allowed.has(capability.name))
        .map((capability) => ({ ...capability }));
      discovered.set(id, safe);
      return safe.map((capability) => structuredClone(capability));
    },

    async health(id: string): Promise<ConnectorHealth> {
      const manifest = registry.get(id);
      if (!manifest) throw new Error(`unknown connector: ${id}`);
      const snapshot = options.health?.(id);
      let status: ConnectorHealthStatus = "unknown";
      if (snapshot) {
        status = snapshot.healthy ? (snapshot.failures > 0 ? "degraded" : "healthy") : "unhealthy";
      }
      return {
        connector_id: id,
        status,
        active: snapshot?.active ?? 0,
        failures: snapshot?.failures ?? 0,
        checked_at: new Date().toISOString(),
        ...(snapshot?.unhealthyUntil && snapshot.unhealthyUntil > Date.now() ? { next_retry_at: new Date(snapshot.unhealthyUntil).toISOString() } : {}),
        capabilities: (discovered.get(id) ?? manifestCapabilities(manifest)).map((capability) => structuredClone(capability)),
      };
    },

    async readiness(): Promise<ConnectorReadiness> {
      const connectors = await Promise.all(registry.list().map((manifest) => this.health(manifest.id)));
      return { ready: connectors.length > 0 && connectors.every((connector) => connector.status === "healthy"), checked_at: new Date().toISOString(), connectors };
    },
  };
}
