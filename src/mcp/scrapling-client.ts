import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpToolConnection } from "./searxng-client.ts";

async function defaultConnect(): Promise<McpToolConnection> {
  const scraplingUrl = process.env.SCRAPLING_URL ?? "http://scrapling:8000/mcp";
  const transport = new StreamableHTTPClientTransport(new URL(scraplingUrl));
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

// Uses Scrapling's browser-rendered "fetch" tool (full page, not the raw
// "get" tool) since our web_search tool already covers plain HTTP lookups.
export async function callScrape(
  url: string,
  connect: () => Promise<McpToolConnection> = defaultConnect
): Promise<string> {
  const connection = await connect();
  try {
    return await connection.callTool("fetch", { url });
  } finally {
    await connection.close();
  }
}
