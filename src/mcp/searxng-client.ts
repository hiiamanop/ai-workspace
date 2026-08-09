import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpToolConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

async function defaultConnect(): Promise<McpToolConnection> {
  const searxngUrl = process.env.SEARXNG_URL ?? "http://searxng:8080";
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mcp-searxng"],
    env: { ...process.env, SEARXNG_URL: searxngUrl },
  });
  const client = new Client({ name: "ai-workspace", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content;
      if (Array.isArray(content)) {
        return content.map((c: { text?: string }) => c.text ?? "").join("\n");
      }
      return String(content ?? "");
    },
    close: () => client.close(),
  };
}

// ponytail: spawns a fresh mcp-searxng subprocess per call — simplest thing
// that works for low-frequency chat tool calls. Upgrade to a persistent
// pooled connection if subprocess startup latency becomes measurable.
export async function callWebSearch(
  query: string,
  connect: () => Promise<McpToolConnection> = defaultConnect
): Promise<string> {
  const connection = await connect();
  try {
    return await connection.callTool("searxng_web_search", { query });
  } finally {
    await connection.close();
  }
}
