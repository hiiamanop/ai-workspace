import type { ToolDef } from "./types.ts";

export const TOOL_DEFS: Record<string, ToolDef> = {
  web_search: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  scrape: {
    type: "function",
    function: {
      name: "scrape",
      description: "Fetch and extract the full readable content of a web page",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
};
