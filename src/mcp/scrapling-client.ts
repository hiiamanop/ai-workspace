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

const BLOCKED_HOSTNAMES = new Set([
  "searxng",
  "scrapling",
  "made",
  "host.docker.internal",
  "localhost",
]);

function isPrivateIPv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 0) return true;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function assertUrlAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`scrape refused: "${url}" is not a valid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`scrape refused: unsupported scheme "${parsed.protocol}"`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // ponytail: blocks all IPv6 literals rather than parsing private ranges —
  // revisit with proper IPv6 range checks only if a real need to scrape an
  // IPv6-literal URL shows up. Legitimate scrape targets are domain names.
  if (hostname.startsWith("[")) {
    throw new Error("scrape refused: IPv6 literal hosts are not allowed");
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || isPrivateIPv4(hostname)) {
    throw new Error("scrape refused: URL targets an internal/private host");
  }
}

// Uses Scrapling's browser-rendered "fetch" tool (full page, not the raw
// "get" tool) since our web_search tool already covers plain HTTP lookups.
export async function callScrape(
  url: string,
  connect: () => Promise<McpToolConnection> = defaultConnect
): Promise<string> {
  assertUrlAllowed(url);
  const connection = await connect();
  try {
    return await connection.callTool("fetch", { url });
  } finally {
    await connection.close();
  }
}
