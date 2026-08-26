// Provisions web_search + scrape as native Open WebUI Tools (D1).
// Tool Python source calls back into this project's own /api/web-search and
// /api/scrape routes. The backend base URL is configurable per tool via the
// `backend_url` valve — default "http://app:3000" resolves to the compose
// `app` service from inside the open-webui container; host-dev setups set
// OPENWEBUI_BACKEND_URL=http://localhost:3000 (or edit the valve in the UI).

export interface ToolMadeScores {
  cost_per_1k_tokens: number;
  quality: number;
  latency: number;
  business_risk: number;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: string;
  madeScores: ToolMadeScores;
}

// Open WebUI derives meta.manifest by re-parsing this frontmatter block out
// of `content` on every create/update (see extract_frontmatter() in its own
// utils/plugin.py) — it overwrites whatever `meta.manifest` you POST, so
// made_scores has to live here, not in the request payload's meta field.
// The parser only understands flat `key: value` string lines, no nesting.
// Key names must be pure [a-z_]+ — Open WebUI's frontmatter regex
// (extract_frontmatter in its own utils/plugin.py) doesn't allow digits, so
// e.g. "made_cost_per_1k_tokens" would silently fail to match and get
// dropped. "made_cost" stands in for cost_per_1k_tokens.
export function withFrontmatter(source: string, scores: ToolMadeScores): string {
  return `"""
made_cost: ${scores.cost_per_1k_tokens}
made_quality: ${scores.quality}
made_latency: ${scores.latency}
made_business_risk: ${scores.business_risk}
"""
${source}`;
}

export interface ProvisionToolsDeps {
  openwebuiUrl: string;
  adminEmail: string;
  adminPassword: string;
  backendUrl?: string;
  fetchFn?: typeof fetch;
}

export interface ProvisionToolsResult {
  ok: boolean;
  error?: string;
  actions: { id: string; action: "created" | "updated" | "up-to-date" }[];
}

// Class-based Tools format: this fork of Open WebUI's loader
// (load_tool_module_by_id) only accepts modules with a Tools class — the
// module-level function format raises "No Tools class found in the module".
const webSearchSource = `from pydantic import BaseModel, Field
import requests


class Tools:
    class Valves(BaseModel):
        backend_url: str = Field(
            default="http://app:3000",
            description="Base URL of the ai-workspace backend (http://app:3000 inside docker, http://localhost:3000 for host-dev)",
        )

    def __init__(self):
        self.valves = self.Valves()

    def web_search(self, query: str, language: str = "en") -> dict:
        """Search the web using SearXNG. Returns structured results with titles, URLs, and snippets."""
        try:
            response = requests.post(
                f"{self.valves.backend_url}/api/web-search",
                json={"query": query, "language": language},
                timeout=10,
            )
        except requests.RequestException as exc:
            return {"status": "error", "error": f"Search failed: {exc}"}
        if response.status_code == 200:
            results = response.json()
            return {
                "status": "success",
                "results": results.get("results", []),
                "count": len(results.get("results", [])),
            }
        return {"status": "error", "error": f"Search failed: {response.status_code}"}
`;

const scrapeSource = `from pydantic import BaseModel, Field
import requests


class Tools:
    class Valves(BaseModel):
        backend_url: str = Field(
            default="http://app:3000",
            description="Base URL of the ai-workspace backend (http://app:3000 inside docker, http://localhost:3000 for host-dev)",
        )

    def __init__(self):
        self.valves = self.Valves()

    def scrape(self, url: str) -> dict:
        """Scrape content from a URL. Returns markdown-formatted text."""
        try:
            response = requests.post(
                f"{self.valves.backend_url}/api/scrape",
                json={"url": url},
                timeout=10,
            )
        except requests.RequestException as exc:
            return {"status": "error", "error": f"Scrape failed: {exc}"}
        if response.status_code == 200:
            data = response.json()
            return {"status": "success", "content": data.get("content", ""), "url": url}
        return {"status": "error", "error": f"Scrape failed: {response.status_code}"}
`;

// Scores mirror src/candidates.ts's WEB_SEARCH_CANDIDATE/SCRAPE_CANDIDATE —
// one source of truth for "how good is this tool" shared with the
// ai-workspace-native tool loop (chat.ts).
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: "web_search",
    name: "Web Search",
    description: "Search the web using SearXNG. Returns structured results with titles, URLs, and snippets.",
    tags: ["search", "web", "information-retrieval"],
    source: webSearchSource,
    madeScores: { cost_per_1k_tokens: 0, quality: 0.7, latency: 3000, business_risk: 0.2 },
  },
  {
    id: "scrape",
    name: "Web Scrape",
    description: "Scrape content from a URL. Returns markdown-formatted text.",
    tags: ["scrape", "web", "content-extraction"],
    source: scrapeSource,
    madeScores: { cost_per_1k_tokens: 0, quality: 0.7, latency: 6000, business_risk: 0.3 },
  },
];

export async function provisionTools(deps: ProvisionToolsDeps): Promise<ProvisionToolsResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const backendUrl = deps.backendUrl ?? process.env.OPENWEBUI_BACKEND_URL ?? "http://app:3000";

  const signinRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: deps.adminEmail, password: deps.adminPassword }),
  });
  const signinBody = (await signinRes.json()) as { token?: string; detail?: string };
  if (!signinRes.ok || !signinBody.token) {
    return {
      ok: false,
      error: signinBody.detail ?? `sign-in failed with status ${signinRes.status}`,
      actions: [],
    };
  }
  const adminToken = signinBody.token;
  const authHeaders = { authorization: `Bearer ${adminToken}` };

  const actions: ProvisionToolsResult["actions"] = [];
  for (const tool of TOOL_DEFINITIONS) {
    const content = withFrontmatter(tool.source, tool.madeScores);
    const payload = {
      id: tool.id,
      name: tool.name,
      content,
      meta: { description: tool.description, author: "ai-workspace", tags: tool.tags },
    };

    const existingRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/tools/id/${tool.id}`, {
      method: "GET",
      headers: authHeaders,
    });

    let action: "created" | "updated" | "up-to-date";
    if (existingRes.ok) {
      const existing = (await existingRes.json()) as { content?: string };
      if (existing.content === content) {
        action = "up-to-date";
      } else {
        const updateRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/tools/id/${tool.id}/update`, {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!updateRes.ok) {
          const body = (await updateRes.json().catch(() => ({}))) as { detail?: string };
          return { ok: false, error: body.detail ?? `update ${tool.id} failed: ${updateRes.status}`, actions };
        }
        action = "updated";
      }
    } else {
      const createRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/tools/create`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!createRes.ok) {
        const body = (await createRes.json().catch(() => ({}))) as { detail?: string };
        return { ok: false, error: body.detail ?? `create ${tool.id} failed: ${createRes.status}`, actions };
      }
      action = "created";
    }

    // Ensure the backend_url valve points at the right deployment. Even for
    // "up-to-date" tools this re-applies the current env value.
    const valvesRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/tools/id/${tool.id}/valves/update`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ backend_url: backendUrl }),
    });
    if (!valvesRes.ok) {
      const body = (await valvesRes.json().catch(() => ({}))) as { detail?: string };
      return {
        ok: false,
        error: body.detail ?? `valves update for ${tool.id} failed: ${valvesRes.status}`,
        actions,
      };
    }

    actions.push({ id: tool.id, action });
  }

  return { ok: true, actions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const openwebuiUrl = process.env.OPENWEBUI_URL ?? "http://localhost:3001";
  const adminEmail = process.env.OPENWEBUI_ADMIN_EMAIL ?? "";
  const adminPassword = process.env.OPENWEBUI_ADMIN_PASSWORD ?? "";

  provisionTools({ openwebuiUrl, adminEmail, adminPassword }).then((result) => {
    if (!result.ok) {
      console.error(`Provisioning failed: ${result.error}`);
      process.exit(1);
    }
    for (const { id, action } of result.actions) {
      console.log(`${id}: ${action}`);
    }
    console.log("Tools provisioned successfully.");
  });
}
