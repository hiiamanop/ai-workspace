// Provisions Open WebUI Tools this project owns. Two valve shapes:
//  - web_search/scrape/memory: `backend_url` — calls this project's own
//    /api/* routes, no Open WebUI auth needed.
//  - knowledge_search/read_file/generate_image: `openwebui_url` +
//    `openwebui_token` — calls Open WebUI's own REST API, needs the shared
//    admin API key (see src/openwebui-auth.ts — mint once, share across
//    every tool that needs it, never mint independently per tool).
import { mintApiKey } from "./openwebui-auth.ts";

export interface ToolMadeScores {
  cost_per_1k_tokens: number;
  quality: number;
  latency: number;
  business_risk: number;
}

export interface ToolValveContext {
  backendUrl: string;
  openwebuiUrl: string;
  openwebuiToken: string;
  fetchFn: typeof fetch;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: string;
  madeScores: ToolMadeScores;
  valves: (ctx: ToolValveContext) => Record<string, string>;
  // Precondition for the tool to exist at all — e.g. generate_image only
  // makes sense once an image backend is actually configured. Omit for
  // tools with no precondition (always provisioned).
  isEnabled?: (ctx: ToolValveContext) => Promise<boolean>;
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

const knowledgeSearchSource = `from pydantic import BaseModel, Field
import requests


class Tools:
    class Valves(BaseModel):
        openwebui_url: str = Field(
            default="http://open-webui:8080",
            description="Open WebUI's own base URL, reachable from inside its own container",
        )
        openwebui_token: str = Field(
            default="",
            description="Admin API key for Open WebUI's own API (provisioned automatically)",
        )
        default_collections: str = Field(
            default="",
            description="Comma-separated Knowledge collection names to search (admin-configured; the API requires explicit names, there's no 'search everything')",
        )

    def __init__(self):
        self.valves = self.Valves()

    def knowledge_search(self, query: str) -> dict:
        """Search the admin-configured Knowledge base(s) for content relevant to the query."""
        collections = [c.strip() for c in self.valves.default_collections.split(",") if c.strip()]
        if not collections:
            return {"status": "error", "error": "No knowledge collections configured (default_collections valve is empty)"}
        try:
            response = requests.post(
                f"{self.valves.openwebui_url}/api/v1/retrieval/query/collection",
                headers={"Authorization": f"Bearer {self.valves.openwebui_token}"},
                json={"collection_names": collections, "query": query},
                timeout=15,
            )
        except requests.RequestException as exc:
            return {"status": "error", "error": f"Knowledge search failed: {exc}"}
        if response.status_code == 200:
            return {"status": "success", "results": response.json()}
        return {"status": "error", "error": f"Knowledge search failed: {response.status_code}"}
`;

const readFileSource = `from pydantic import BaseModel, Field
import requests


class Tools:
    class Valves(BaseModel):
        openwebui_url: str = Field(
            default="http://open-webui:8080",
            description="Open WebUI's own base URL, reachable from inside its own container",
        )
        openwebui_token: str = Field(
            default="",
            description="Admin API key for Open WebUI's own API (provisioned automatically)",
        )

    def __init__(self):
        self.valves = self.Valves()

    def read_file(self, file_id: str) -> dict:
        """Read the extracted text content of a file attached to this conversation, given its file id."""
        try:
            response = requests.get(
                f"{self.valves.openwebui_url}/api/v1/files/{file_id}/data/content",
                headers={"Authorization": f"Bearer {self.valves.openwebui_token}"},
                timeout=15,
            )
        except requests.RequestException as exc:
            return {"status": "error", "error": f"Read file failed: {exc}"}
        if response.status_code == 200:
            return {"status": "success", "content": response.json().get("content", "")}
        return {"status": "error", "error": f"Read file failed: {response.status_code}"}
`;

const generateImageSource = `from pydantic import BaseModel, Field
import requests


class Tools:
    class Valves(BaseModel):
        openwebui_url: str = Field(
            default="http://open-webui:8080",
            description="Open WebUI's own base URL, reachable from inside its own container",
        )
        openwebui_token: str = Field(
            default="",
            description="Admin API key for Open WebUI's own API (provisioned automatically)",
        )

    def __init__(self):
        self.valves = self.Valves()

    def generate_image(self, prompt: str) -> dict:
        """Generate an image from a text prompt. Requires an image generation backend configured in Open WebUI's Admin Settings."""
        try:
            response = requests.post(
                f"{self.valves.openwebui_url}/api/v1/images/generations",
                headers={"Authorization": f"Bearer {self.valves.openwebui_token}"},
                json={"prompt": prompt},
                timeout=60,
            )
        except requests.RequestException as exc:
            return {"status": "error", "error": f"Image generation failed: {exc}"}
        if response.status_code == 200:
            return {"status": "success", "images": response.json()}
        return {"status": "error", "error": f"Image generation failed: {response.status_code}"}
`;

const memorySource = `from pydantic import BaseModel, Field
import requests


class Tools:
    class Valves(BaseModel):
        backend_url: str = Field(
            default="http://app:3000",
            description="Base URL of the ai-workspace backend (http://app:3000 inside docker, http://localhost:3000 for host-dev)",
        )

    def __init__(self):
        self.valves = self.Valves()

    def remember(self, fact: str, __user__: dict = {}) -> dict:
        """Remember a fact about the current user, for recall in future conversations."""
        try:
            response = requests.post(
                f"{self.valves.backend_url}/api/memory/remember",
                json={"user_id": __user__.get("id", "anonymous"), "fact": fact},
                timeout=10,
            )
        except requests.RequestException as exc:
            return {"status": "error", "error": f"Remember failed: {exc}"}
        if response.status_code == 200:
            return {"status": "success", "entry": response.json()}
        return {"status": "error", "error": f"Remember failed: {response.status_code}"}

    def recall(self, query: str = "", __user__: dict = {}) -> dict:
        """Recall previously remembered facts about the current user, optionally filtered by a search term."""
        try:
            response = requests.post(
                f"{self.valves.backend_url}/api/memory/recall",
                json={"user_id": __user__.get("id", "anonymous"), "query": query},
                timeout=10,
            )
        except requests.RequestException as exc:
            return {"status": "error", "error": f"Recall failed: {exc}"}
        if response.status_code == 200:
            return {"status": "success", "entries": response.json().get("entries", [])}
        return {"status": "error", "error": f"Recall failed: {response.status_code}"}
`;

// Scores mirror src/candidates.ts's WEB_SEARCH_CANDIDATE/SCRAPE_CANDIDATE for
// the first two — one source of truth for "how good is this tool" shared
// with the ai-workspace-native tool loop (chat.ts). The rest are new
// estimates (ponytail: not measured from real usage yet).
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: "web_search",
    name: "Web Search",
    description: "Search the web using SearXNG. Returns structured results with titles, URLs, and snippets.",
    tags: ["search", "web", "information-retrieval"],
    source: webSearchSource,
    madeScores: { cost_per_1k_tokens: 0, quality: 0.7, latency: 3000, business_risk: 0.2 },
    valves: (ctx) => ({ backend_url: ctx.backendUrl }),
  },
  {
    id: "scrape",
    name: "Web Scrape",
    description: "Scrape content from a URL. Returns markdown-formatted text.",
    tags: ["scrape", "web", "content-extraction"],
    source: scrapeSource,
    madeScores: { cost_per_1k_tokens: 0, quality: 0.7, latency: 6000, business_risk: 0.3 },
    valves: (ctx) => ({ backend_url: ctx.backendUrl }),
  },
  {
    id: "knowledge_search",
    name: "Knowledge Search",
    description: "Search the admin-configured Knowledge base(s) in Open WebUI.",
    tags: ["knowledge", "rag", "search"],
    source: knowledgeSearchSource,
    madeScores: { cost_per_1k_tokens: 0, quality: 0.75, latency: 2000, business_risk: 0.2 },
    valves: (ctx) => ({ openwebui_url: ctx.openwebuiUrl, openwebui_token: ctx.openwebuiToken }),
  },
  {
    id: "read_file",
    name: "Read File",
    description: "Read the extracted text content of a file attached to the conversation.",
    tags: ["files", "rag"],
    source: readFileSource,
    madeScores: { cost_per_1k_tokens: 0, quality: 0.8, latency: 1500, business_risk: 0.2 },
    valves: (ctx) => ({ openwebui_url: ctx.openwebuiUrl, openwebui_token: ctx.openwebuiToken }),
  },
  {
    id: "generate_image",
    name: "Generate Image",
    description: "Generate an image from a text prompt via Open WebUI's configured image generation backend.",
    tags: ["image", "generation"],
    source: generateImageSource,
    madeScores: { cost_per_1k_tokens: 0.01, quality: 0.6, latency: 15000, business_risk: 0.3 },
    valves: (ctx) => ({ openwebui_url: ctx.openwebuiUrl, openwebui_token: ctx.openwebuiToken }),
    isEnabled: async (ctx) => {
      try {
        const res = await ctx.fetchFn(`${ctx.openwebuiUrl}/api/v1/images/config`, {
          headers: { authorization: `Bearer ${ctx.openwebuiToken}` },
        });
        if (!res.ok) return false;
        const config = (await res.json()) as { ENABLE_IMAGE_GENERATION?: boolean };
        return config.ENABLE_IMAGE_GENERATION === true;
      } catch {
        return false;
      }
    },
  },
  {
    id: "memory",
    name: "Memory",
    description: "Remember and recall facts about the current user across conversations.",
    tags: ["memory", "personalization"],
    source: memorySource,
    madeScores: { cost_per_1k_tokens: 0, quality: 0.7, latency: 500, business_risk: 0.4 },
    valves: (ctx) => ({ backend_url: ctx.backendUrl }),
  },
];

export interface ProvisionToolsDeps {
  openwebuiUrl: string;
  adminEmail: string;
  adminPassword: string;
  backendUrl?: string;
  // Share a pre-minted key when provisioning more than one thing in the
  // same run (see openwebui-auth.ts) — omit to mint one here standalone.
  openwebuiToken?: string;
  fetchFn?: typeof fetch;
}

export interface ProvisionToolsResult {
  ok: boolean;
  error?: string;
  actions: { id: string; action: "created" | "updated" | "up-to-date" | "removed" | "disabled" }[];
}

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

  let openwebuiToken = deps.openwebuiToken;
  if (!openwebuiToken) {
    const minted = await mintApiKey({
      openwebuiUrl: deps.openwebuiUrl,
      adminEmail: deps.adminEmail,
      adminPassword: deps.adminPassword,
      fetchFn,
    });
    if (!minted.ok || !minted.apiKey) {
      return { ok: false, error: minted.error ?? "failed to mint an Open WebUI API key", actions: [] };
    }
    openwebuiToken = minted.apiKey;
  }

  const valveCtx: ToolValveContext = { backendUrl, openwebuiUrl: deps.openwebuiUrl, openwebuiToken, fetchFn };

  const actions: ProvisionToolsResult["actions"] = [];
  for (const tool of TOOL_DEFINITIONS) {
    const existingRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/tools/id/${tool.id}`, {
      method: "GET",
      headers: authHeaders,
    });

    if (tool.isEnabled && !(await tool.isEnabled(valveCtx))) {
      if (existingRes.ok) {
        const deleteRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/tools/id/${tool.id}/delete`, {
          method: "DELETE",
          headers: authHeaders,
        });
        if (!deleteRes.ok) {
          const body = (await deleteRes.json().catch(() => ({}))) as { detail?: string };
          return { ok: false, error: body.detail ?? `remove ${tool.id} failed: ${deleteRes.status}`, actions };
        }
        actions.push({ id: tool.id, action: "removed" });
      } else {
        actions.push({ id: tool.id, action: "disabled" });
      }
      continue;
    }

    const content = withFrontmatter(tool.source, tool.madeScores);
    const payload = {
      id: tool.id,
      name: tool.name,
      content,
      meta: { description: tool.description, author: "ai-workspace", tags: tool.tags },
    };

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

    // Ensure valves point at the right deployment. Even for "up-to-date"
    // tools this re-applies the current values.
    const valvesRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/tools/id/${tool.id}/valves/update`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(tool.valves(valveCtx)),
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
