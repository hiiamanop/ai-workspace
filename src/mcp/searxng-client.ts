import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpToolConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  answer?: string;
}

async function defaultConnect(): Promise<McpToolConnection> {
  const searxngUrl = process.env.SEARXNG_URL ?? "http://searxng:8080";
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["mcp-searxng"],
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

interface RawSearxngResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
}

interface RawSearxngResponse {
  results?: unknown;
  answers?: unknown;
}

function parseSearxngJson(raw: string): WebSearchResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`searxng returned non-JSON response: ${raw.slice(0, 200)}`);
  }
  const data = parsed as RawSearxngResponse;
  if (!Array.isArray(data.results)) {
    throw new Error("searxng response missing results array");
  }
  const results: WebSearchResult[] = (data.results as RawSearxngResult[])
    .map((r) => ({
      title: typeof r?.title === "string" ? r.title : "",
      url: typeof r?.url === "string" ? r.url : "",
      snippet: typeof r?.content === "string" ? r.content : "",
      ...(typeof r?.publishedDate === "string" && r.publishedDate ? { publishedDate: r.publishedDate } : {}),
    }))
    // Citations must point to an actual web URL returned by the search
    // provider. Never manufacture a placeholder URL for malformed results.
    .filter((r) => {
      try {
        const parsed = new URL(r.url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    });
  const answers = Array.isArray(data.answers) ? (data.answers as unknown[]).map(String) : [];
  return {
    results,
    ...(answers.length > 0 ? { answer: answers.join(" ") } : {}),
  };
}

// ponytail: spawns a fresh mcp-searxng subprocess per call — simplest thing
// that works for low-frequency chat tool calls. Upgrade to a persistent
// pooled connection if subprocess startup latency becomes measurable.
export async function callWebSearch(
  query: string,
  maxResults?: number,
  connect: () => Promise<McpToolConnection> = defaultConnect
): Promise<WebSearchResponse> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error("web search query must not be empty");
  }
  const normalizedMaxResults = maxResults === undefined
    ? undefined
    : Math.max(1, Math.min(10, Math.floor(maxResults)));
  const connection = await connect();
  try {
    const raw = await connection.callTool("searxng_web_search", {
      query: normalizedQuery,
      response_format: "json",
      ...(normalizedMaxResults !== undefined ? { num_results: normalizedMaxResults } : {}),
    });
    return parseSearxngJson(raw);
  } finally {
    await connection.close();
  }
}
