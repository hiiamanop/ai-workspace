// Provisions web_search + scrape as native Open WebUI Tools (D1).
// Tool Python source calls back into this project's own /api/web-search and
// /api/scrape routes. The backend base URL is configurable per tool via the
// `backend_url` valve — default "http://app:3000" resolves to the compose
// `app` service from inside the open-webui container; host-dev setups set
// OPENWEBUI_BACKEND_URL=http://localhost:3000 (or edit the valve in the UI).

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: string;
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

const webSearchSource = `from pydantic import BaseModel, Field
import requests

class Valves(BaseModel):
    backend_url: str = Field(
        default="http://app:3000",
        description="Base URL of the ai-workspace backend (http://app:3000 inside docker, http://localhost:3000 for host-dev)",
    )

def web_search(query: str, language: str = "en") -> dict:
    """Search the web using SearXNG. Returns structured results with titles, URLs, and snippets."""
    try:
        response = requests.post(
            f"{valves.backend_url}/api/web-search",
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

class Valves(BaseModel):
    backend_url: str = Field(
        default="http://app:3000",
        description="Base URL of the ai-workspace backend (http://app:3000 inside docker, http://localhost:3000 for host-dev)",
    )

def scrape(url: str) -> dict:
    """Scrape content from a URL. Returns markdown-formatted text."""
    try:
        response = requests.post(
            f"{valves.backend_url}/api/scrape",
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

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: "web_search",
    name: "Web Search",
    description: "Search the web using SearXNG. Returns structured results with titles, URLs, and snippets.",
    tags: ["search", "web", "information-retrieval"],
    source: webSearchSource,
  },
  {
    id: "scrape",
    name: "Web Scrape",
    description: "Scrape content from a URL. Returns markdown-formatted text.",
    tags: ["scrape", "web", "content-extraction"],
    source: scrapeSource,
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
    const payload = {
      id: tool.id,
      name: tool.name,
      content: tool.source,
      meta: { description: tool.description, author: "ai-workspace", tags: tool.tags },
    };

    const existingRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/tools/id/${tool.id}`, {
      method: "GET",
      headers: authHeaders,
    });

    let action: "created" | "updated" | "up-to-date";
    if (existingRes.ok) {
      const existing = (await existingRes.json()) as { content?: string };
      if (existing.content === tool.source) {
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
