import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionTools, TOOL_DEFINITIONS } from "../src/openwebui-provision-tools.ts";

const deps = {
  openwebuiUrl: "http://open-webui:8080",
  adminEmail: "admin@example.com",
  adminPassword: "secret",
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

test("provisionTools() creates both tools when missing and sets valves", async () => {
  const createBodies: string[] = [];
  const valveBodies: string[] = [];
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () =>
      new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    "/api/v1/tools/id/web_search": () => new Response(JSON.stringify({ detail: "nf" }), { status: 404 }),
    "/api/v1/tools/id/scrape": () => new Response(JSON.stringify({ detail: "nf" }), { status: 404 }),
    "/api/v1/tools/create": (init) => {
      createBodies.push(String(init?.body));
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    },
    "/valves/update": (init) => {
      valveBodies.push(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const result = await provisionTools({ ...deps, fetchFn, backendUrl: "http://app:3000" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.actions, [
    { id: "web_search", action: "created" },
    { id: "scrape", action: "created" },
  ]);
  assert.equal(createBodies.length, 2);
  assert.match(createBodies[0], /"id":"web_search"/);
  assert.match(createBodies[1], /"id":"scrape"/);
  assert.equal(valveBodies.length, 2);
  for (const body of valveBodies) {
    assert.match(body, /"backend_url":"http:\/\/app:3000"/);
  }
});

test("provisionTools() updates a tool when source differs", async () => {
  const updateCalls: string[] = [];
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () =>
      new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    "/api/v1/tools/id/web_search": () =>
      new Response(
        JSON.stringify({ id: "web_search", content: "def web_search(query):\n    return {'old': True}" }),
        { status: 200 }
      ),
    "/api/v1/tools/id/scrape": () => new Response(JSON.stringify({ detail: "nf" }), { status: 404 }),
    "/api/v1/tools/id/web_search/update": (init) => {
      updateCalls.push(String(init?.body));
      return new Response(JSON.stringify({ id: "web_search" }), { status: 200 });
    },
    "/api/v1/tools/create": () => new Response(JSON.stringify({ id: "scrape" }), { status: 200 }),
    "/valves/update": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  const result = await provisionTools({ ...deps, fetchFn });

  assert.equal(result.ok, true);
  assert.deepEqual(result.actions, [
    { id: "web_search", action: "updated" },
    { id: "scrape", action: "created" },
  ]);
  assert.equal(updateCalls.length, 1);
  assert.match(updateCalls[0], /"id":"web_search"/);
});

test("provisionTools() skips tools that are already up-to-date", async () => {
  let createCalls = 0;
  let updateCalls = 0;
  const fetchFn = fakeFetch({
    "/api/v1/auths/signin": () =>
      new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    "/api/v1/tools/id/web_search": () =>
      new Response(JSON.stringify({ id: "web_search", content: TOOL_DEFINITIONS[0].source }), {
        status: 200,
      }),
    "/api/v1/tools/id/scrape": () =>
      new Response(JSON.stringify({ id: "scrape", content: TOOL_DEFINITIONS[1].source }), { status: 200 }),
    "/api/v1/tools/create": () => {
      createCalls++;
      return new Response(JSON.stringify({}), { status: 200 });
    },
    "/valves/update": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    "/api/v1/tools/id/web_search/update": () => {
      updateCalls++;
      return new Response(JSON.stringify({}), { status: 200 });
    },
    "/api/v1/tools/id/scrape/update": () => {
      updateCalls++;
      return new Response(JSON.stringify({}), { status: 200 });
    },
  });

  const result = await provisionTools({ ...deps, fetchFn });

  assert.equal(result.ok, true);
  assert.deepEqual(result.actions, [
    { id: "web_search", action: "up-to-date" },
    { id: "scrape", action: "up-to-date" },
  ]);
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
    "/api/v1/auths/signin": () =>
      new Response(JSON.stringify({ token: "tok-1" }), { status: 200 }),
    "/api/v1/tools/id/web_search": () => new Response(JSON.stringify({ detail: "nf" }), { status: 404 }),
    "/api/v1/tools/id/scrape": () => new Response(JSON.stringify({ detail: "nf" }), { status: 404 }),
    "/api/v1/tools/create": () => new Response(JSON.stringify({ detail: "name too long" }), { status: 400 }),
  });

  const result = await provisionTools({ ...deps, fetchFn });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /name too long/);
  assert.deepEqual(result.actions, []);
});

test("tool definitions are structurally valid Python sources", () => {
  assert.equal(TOOL_DEFINITIONS.length, 2);
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.id, "tool id present");
    assert.ok(tool.name, "tool name present");
    assert.ok(tool.description, "tool description present");
    assert.ok(tool.tags.length > 0, "tool has tags");
    // Structural sanity only — no python interpreter in the test env.
    // ponytail: catches typos/regressions in def names, Valves wiring, and
    // the f-string usage; real syntax check happens when Open WebUI loads it.
    assert.match(tool.source, /^from pydantic import BaseModel, Field\nimport requests\n\nclass Valves\(BaseModel\):/);
    assert.match(tool.source, /backend_url: str = Field\(/);
    assert.match(tool.source, /valves\.backend_url/);
    assert.match(tool.source, /timeout=10/);
    assert.match(tool.source, /status": "error"/);
  }
  assert.match(TOOL_DEFINITIONS[0].source, /^def web_search\(query: str, language: str = "en"\) -> dict:/m);
  assert.match(TOOL_DEFINITIONS[1].source, /^def scrape\(url: str\) -> dict:/m);
});
