import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionTools, TOOL_DEFINITIONS, withFrontmatter } from "../src/openwebui-provision-tools.ts";

const TOOL_IDS = TOOL_DEFINITIONS.map((t) => t.id);
const BACKEND_URL_TOOL_IDS = new Set(["web_search", "scrape", "memory"]);
const OPENWEBUI_TOOL_IDS = new Set(["knowledge_search", "read_file", "generate_image"]);

const deps = {
  openwebuiUrl: "http://open-webui:8080",
  adminEmail: "admin@example.com",
  adminPassword: "secret",
  openwebuiToken: "test-token", // skip minting — that flow is covered in openwebui-auth.test.ts
  fetchFn: fetch,
};

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  return async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (u.endsWith(suffix)) {
        return await handler(init);
      }
    }
    return new Response(JSON.stringify({ detail: "unexpected URL: " + u }), { status: 500 });
  };
}

function notFoundForEveryTool(): Record<string, () => Response> {
  const routes: Record<string, () => Response> = {};
  for (const id of TOOL_IDS) {
    routes[`/api/v1/tools/id/${id}`] = () => new Response(JSON.stringify({ detail: "nf" }), { status: 404 });
  }
  return routes;
}

// generate_image's isEnabled check calls this — default to enabled so the
// generic tests exercise all 6 tools uniformly; the dedicated test below
// overrides it to false.
function imageGenConfig(enabled: boolean) {
  return {
    "/api/v1/images/config": () =>
      new Response(JSON.stringify({ ENABLE_IMAGE_GENERATION: enabled }), { status: 200 }),
  };
}

test("provisionTools() creates every tool when missing and sets the right valves per tool", async () => {
  const createBodies: string[] = [];
  const valveBodiesById: Record<string, string> = {};
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () => new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    ...notFoundForEveryTool(),
    ...imageGenConfig(true),
    "/api/v1/tools/create": (init) => {
      createBodies.push(String(init?.body));
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    },
  });
  // valves/update needs the tool id from the URL — wrap fetchFn instead of relying on suffix matching alone.
  const wrappedFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const m = u.match(/\/api\/v1\/tools\/id\/([^/]+)\/valves\/update$/);
    if (m) {
      valveBodiesById[m[1]] = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return fetchFn(url, init);
  };

  const result = await provisionTools({ ...deps, fetchFn: wrappedFetch, backendUrl: "http://app:3000" });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.actions,
    TOOL_IDS.map((id) => ({ id, action: "created" as const }))
  );
  assert.equal(createBodies.length, TOOL_IDS.length);
  for (const id of TOOL_IDS) {
    assert.ok(
      createBodies.some((b) => b.includes(`"id":"${id}"`)),
      `expected a create call for ${id}`
    );
  }

  for (const id of BACKEND_URL_TOOL_IDS) {
    assert.match(valveBodiesById[id], /"backend_url":"http:\/\/app:3000"/);
  }
  for (const id of OPENWEBUI_TOOL_IDS) {
    assert.match(valveBodiesById[id], /"openwebui_url":"http:\/\/open-webui:8080"/);
    assert.match(valveBodiesById[id], /"openwebui_token":"test-token"/);
  }
});

test("provisionTools() updates a tool when source differs", async () => {
  const updateCalls: string[] = [];
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () => new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    ...notFoundForEveryTool(),
    ...imageGenConfig(true),
    "/api/v1/tools/id/web_search": () =>
      new Response(
        JSON.stringify({ id: "web_search", content: "def web_search(query):\n    return {'old': True}" }),
        { status: 200 }
      ),
    "/api/v1/tools/id/web_search/update": (init) => {
      updateCalls.push(String(init?.body));
      return new Response(JSON.stringify({ id: "web_search" }), { status: 200 });
    },
    "/api/v1/tools/create": () => new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    "/valves/update": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  const result = await provisionTools({ ...deps, fetchFn });

  assert.equal(result.ok, true);
  const webSearchAction = result.actions.find((a) => a.id === "web_search");
  assert.equal(webSearchAction?.action, "updated");
  assert.equal(updateCalls.length, 1);
  assert.match(updateCalls[0], /"id":"web_search"/);
});

test("provisionTools() skips tools that are already up-to-date", async () => {
  let createCalls = 0;
  let updateCalls = 0;
  const upToDateRoutes: Record<string, () => Response> = {};
  for (const tool of TOOL_DEFINITIONS) {
    upToDateRoutes[`/api/v1/tools/id/${tool.id}`] = () =>
      new Response(
        JSON.stringify({ id: tool.id, content: withFrontmatter(tool.source, tool.madeScores) }),
        { status: 200 }
      );
    upToDateRoutes[`/api/v1/tools/id/${tool.id}/update`] = () => {
      updateCalls++;
      return new Response(JSON.stringify({}), { status: 200 });
    };
  }
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () => new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    ...upToDateRoutes,
    ...imageGenConfig(true),
    "/api/v1/tools/create": () => {
      createCalls++;
      return new Response(JSON.stringify({}), { status: 200 });
    },
    "/valves/update": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  const result = await provisionTools({ ...deps, fetchFn });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.actions,
    TOOL_IDS.map((id) => ({ id, action: "up-to-date" as const }))
  );
  assert.equal(createCalls, 0);
  assert.equal(updateCalls, 0);
});

test("provisionTools() returns sign-in error without touching tools", async () => {
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () =>
      new Response(JSON.stringify({ detail: "Invalid credentials" }), { status: 401 }),
  });

  const result = await provisionTools({ ...deps, fetchFn });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid credentials");
  assert.deepEqual(result.actions, []);
});

test("provisionTools() returns tool create failure with partial actions", async () => {
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () => new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    ...notFoundForEveryTool(),
    ...imageGenConfig(true),
    "/api/v1/tools/create": () => new Response(JSON.stringify({ detail: "name too long" }), { status: 400 }),
  });

  const result = await provisionTools({ ...deps, fetchFn });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /name too long/);
  assert.deepEqual(result.actions, []);
});

test("provisionTools() mints its own key when none is supplied", async () => {
  let apiKeyCalls = 0;
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () => new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    "/api/v1/auths/api_key": () => {
      apiKeyCalls++;
      return new Response(JSON.stringify({ api_key: "minted-key" }), { status: 200 });
    },
    ...notFoundForEveryTool(),
    ...imageGenConfig(true),
    "/api/v1/tools/create": () => new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    "/valves/update": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  const { openwebuiToken: _skip, ...depsWithoutToken } = deps;
  const result = await provisionTools({ ...depsWithoutToken, fetchFn });

  assert.equal(result.ok, true);
  assert.equal(apiKeyCalls, 1);
});

test("tool definitions are structurally valid Python sources", () => {
  assert.equal(TOOL_DEFINITIONS.length, 6);
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.id, "tool id present");
    assert.ok(tool.name, "tool name present");
    assert.ok(tool.description, "tool description present");
    assert.ok(tool.tags.length > 0, "tool has tags");
    // Structural sanity only — no python interpreter in the test env.
    // ponytail: catches typos/regressions in def names, Valves wiring, and
    // f-string usage; real syntax check happens when Open WebUI loads it.
    assert.match(tool.source, /^from pydantic import BaseModel, Field\nimport requests\n\n\nclass Tools:\n    class Valves\(BaseModel\):/);
    assert.match(tool.source, /status": "error"/);
  }

  for (const id of BACKEND_URL_TOOL_IDS) {
    const tool = TOOL_DEFINITIONS.find((t) => t.id === id)!;
    assert.match(tool.source, /backend_url: str = Field\(/);
    assert.match(tool.source, /valves\.backend_url/);
  }
  for (const id of OPENWEBUI_TOOL_IDS) {
    const tool = TOOL_DEFINITIONS.find((t) => t.id === id)!;
    assert.match(tool.source, /openwebui_url: str = Field\(/);
    assert.match(tool.source, /openwebui_token: str = Field\(/);
    assert.match(tool.source, /valves\.openwebui_token/);
  }

  const bySearch = TOOL_DEFINITIONS.find((t) => t.id === "web_search")!;
  assert.match(bySearch.source, /^    def web_search\(self, query: str, language: str = "en"\) -> dict:/m);
  const byScrape = TOOL_DEFINITIONS.find((t) => t.id === "scrape")!;
  assert.match(byScrape.source, /^    def scrape\(self, url: str\) -> dict:/m);
  const byKnowledge = TOOL_DEFINITIONS.find((t) => t.id === "knowledge_search")!;
  assert.match(byKnowledge.source, /^    def knowledge_search\(self, query: str\) -> dict:/m);
  const byReadFile = TOOL_DEFINITIONS.find((t) => t.id === "read_file")!;
  assert.match(byReadFile.source, /^    def read_file\(self, file_id: str\) -> dict:/m);
  const byImage = TOOL_DEFINITIONS.find((t) => t.id === "generate_image")!;
  assert.match(byImage.source, /^    def generate_image\(self, prompt: str\) -> dict:/m);
  const byMemory = TOOL_DEFINITIONS.find((t) => t.id === "memory")!;
  assert.match(byMemory.source, /^    def remember\(self, fact: str, __user__: dict = \{\}\) -> dict:/m);
  assert.match(byMemory.source, /^    def recall\(self, query: str = "", __user__: dict = \{\}\) -> dict:/m);
});

test("provisionTools() skips generate_image (no create call) when no image backend is configured", async () => {
  const createBodies: string[] = [];
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () => new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    ...notFoundForEveryTool(),
    ...imageGenConfig(false),
    "/api/v1/tools/create": (init) => {
      createBodies.push(String(init?.body));
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    },
    "/valves/update": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  const result = await provisionTools({ ...deps, fetchFn });

  assert.equal(result.ok, true);
  const imageAction = result.actions.find((a) => a.id === "generate_image");
  assert.equal(imageAction?.action, "disabled");
  assert.ok(!createBodies.some((b) => b.includes('"id":"generate_image"')));
});

test("provisionTools() removes an already-provisioned generate_image when the image backend gets disabled later", async () => {
  let deleteCalled = false;
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () => new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    ...notFoundForEveryTool(),
    "/api/v1/tools/id/generate_image": () =>
      new Response(JSON.stringify({ id: "generate_image", content: "old content" }), { status: 200 }),
    ...imageGenConfig(false),
    "/api/v1/tools/id/generate_image/delete": () => {
      deleteCalled = true;
      return new Response(JSON.stringify(true), { status: 200 });
    },
    "/api/v1/tools/create": () => new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    "/valves/update": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  const result = await provisionTools({ ...deps, fetchFn });

  assert.equal(result.ok, true);
  const imageAction = result.actions.find((a) => a.id === "generate_image");
  assert.equal(imageAction?.action, "removed");
  assert.equal(deleteCalled, true);
});
