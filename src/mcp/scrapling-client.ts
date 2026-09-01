import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpToolConnection } from "./searxng-client.ts";
import { assertPublicHttpUrl } from "../security/guards.ts";

async function defaultConnect(): Promise<McpToolConnection> {
  const scraplingUrl = process.env.SCRAPLING_URL ?? "http://scrapling:8000/mcp";
  const authToken = process.env.SCRAPLING_MCP_AUTH_TOKEN;
  const transport = new StreamableHTTPClientTransport(new URL(scraplingUrl), {
    requestInit: authToken
      ? { headers: { authorization: `Bearer ${authToken}` } }
      : undefined,
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

function assertUrlAllowed(url: string): void {
  try { assertPublicHttpUrl(url, "scrape URL"); }
  catch (error) { throw new Error(`scrape refused: ${(error as Error).message}`); }
}

// ponytail: a full rendered page can be tens of thousands of tokens of
// nav/footer/boilerplate dumped straight into the model's context. Cap it
// rather than sending it raw; upgrade to real readability extraction only
// if truncation turns out to cut off content models actually need.
const MAX_SCRAPE_CHARS = 12_000;

function truncateScrapeResult(text: string): string {
  if (text.length <= MAX_SCRAPE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_SCRAPE_CHARS)}\n\n[... truncated, ${text.length - MAX_SCRAPE_CHARS} more characters omitted]`;
}

function normalizeScrapeResult(text: string): string {
  try {
    const parsed = JSON.parse(text) as { content?: unknown; url?: unknown; status?: unknown };
    if (typeof parsed.content !== "undefined") {
      return JSON.stringify({
        status: parsed.status,
        url: parsed.url,
        content: parsed.content,
      });
    }
  } catch {
    // Some MCP servers return plain text; preserve that response unchanged.
  }
  return text;
}

// Uses Scrapling's browser-rendered fetch tool. The MCP server exposes this
// as a read-only operation; callers still get a bounded, normalized result.
export async function callScrape(
  url: string,
  connect: () => Promise<McpToolConnection> = defaultConnect
): Promise<string> {
  assertUrlAllowed(url);
  const connection = await connect();
  try {
    const result = await connection.callTool("fetch", { url });
    return truncateScrapeResult(normalizeScrapeResult(result));
  } finally {
    await connection.close();
  }
}
