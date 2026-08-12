import type { WebSearchResponse } from "./mcp/searxng-client.ts";

export function formatWebSearchResults(response: WebSearchResponse, offset: number): string {
  const lines: string[] = [];
  if (response.answer) {
    lines.push(`Direct answer: ${response.answer}`);
  }
  response.results.forEach((r, i) => {
    const n = offset + i + 1;
    const dateSuffix = r.publishedDate ? ` — ${r.publishedDate}` : "";
    lines.push(`[${n}] ${r.title}${dateSuffix}\n    ${r.snippet}\n    ${r.url}`);
  });
  return lines.join("\n\n") || "(no results)";
}
