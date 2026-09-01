/** Generic MCP connector metadata and capability allowlisting.
 *
 * The registry deliberately contains no vendor-specific runtime branches. A
 * connector adapter owns transport and credentials; this module only
 * validates the manifest and answers whether a capability is declared.
 */
export interface ConnectorManifest {
  id: string;
  version: string;
  description: string;
  mcpServer: string;
  capabilities: string[];
  requiredScopes?: string[];
  destructiveCapabilities?: string[];
  approvalRequiredCapabilities?: string[];
}

export interface ConnectorRegistry {
  register(manifest: ConnectorManifest): void;
  get(id: string): ConnectorManifest | undefined;
  list(): ConnectorManifest[];
  allows(id: string, capability: string): boolean;
  requiresApproval(id: string, capability: string): boolean;
}

const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

function validateManifest(manifest: ConnectorManifest): void {
  if (!ID_RE.test(manifest.id)) throw new Error(`invalid connector id: ${manifest.id}`);
  if (!manifest.version.trim()) throw new Error(`connector ${manifest.id} has no version`);
  if (!manifest.mcpServer.trim()) throw new Error(`connector ${manifest.id} has no MCP server`);
  if (manifest.capabilities.length === 0) throw new Error(`connector ${manifest.id} has no capabilities`);
  const capabilities = new Set(manifest.capabilities);
  for (const capability of [...(manifest.destructiveCapabilities ?? []), ...(manifest.approvalRequiredCapabilities ?? [])]) {
    if (!capabilities.has(capability)) {
      throw new Error(`connector ${manifest.id} references undeclared capability: ${capability}`);
    }
  }
}

export function createConnectorRegistry(initial: ConnectorManifest[] = []): ConnectorRegistry {
  const manifests = new Map<string, ConnectorManifest>();
  const register = (manifest: ConnectorManifest): void => {
    validateManifest(manifest);
    if (manifests.has(manifest.id)) throw new Error(`connector already registered: ${manifest.id}`);
    manifests.set(manifest.id, structuredClone(manifest));
  };
  for (const manifest of initial) register(manifest);
  return {
    register,
    get: (id) => manifests.get(id),
    list: () => [...manifests.values()].map((manifest) => structuredClone(manifest)),
    allows: (id, capability) => manifests.get(id)?.capabilities.includes(capability) ?? false,
    requiresApproval: (id, capability) => manifests.get(id)?.approvalRequiredCapabilities?.includes(capability) ?? false,
  };
}
