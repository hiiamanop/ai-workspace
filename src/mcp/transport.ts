import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConnectorManifest } from "./connector-registry.ts";

export interface McpTransportConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Creates an MCP connection; credentials are supplied only to the transport boundary. */
export async function connectMcp(manifest: ConnectorManifest, credentials: Record<string, string> = {}): Promise<McpTransportConnection> {
  const config = manifest.transport ?? { type: "streamable-http" as const, url: manifest.mcpServer };
  const transport = config.type === "stdio"
    ? new StdioClientTransport({ command: config.command!, args: config.args ?? [], env: Object.fromEntries(Object.entries({ ...process.env, ...credentials }).filter((entry): entry is [string, string] => typeof entry[1] === "string")) })
    : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: Object.keys(credentials).length ? { headers: credentials } : undefined });
  const client = new Client({ name: "ai-workspace", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    callTool: async (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}
