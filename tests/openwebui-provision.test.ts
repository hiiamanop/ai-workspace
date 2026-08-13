import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionFilter } from "../src/openwebui-provision.ts";

test("provisionFilter() signs in, creates API key, creates function, and sets valves", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/auths/api_key")) {
      return new Response(JSON.stringify({ key: "api-key-xyz" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/functions/id/made_routing")) {
      // GET check: function doesn't exist yet
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    }
    if (u.endsWith("/api/v1/functions/create")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.id, "made_routing");
      assert.equal(body.type, "filter");
      assert.match(body.content, /class Filter/);
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer tok-123");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.endsWith("/valves/update")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.MADE_URL, "http://made:8000");
      assert.equal(body.OPENWEBUI_URL, "http://open-webui:8080");
      assert.equal(body.OPENWEBUI_TOKEN, "api-key-xyz");
      assert.equal(body.CLASSIFIER_MODEL, "deepseek-v4-flash");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await provisionFilter({
    openwebuiUrl: "http://open-webui:8080",
    madeUrl: "http://made:8000",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname,
    classifierModel: "deepseek-v4-flash",
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.endsWith("/api/v1/auths/signin")));
  assert.ok(calls.some((c) => c.endsWith("/api/v1/auths/api_key")));
  assert.ok(calls.some((c) => c.endsWith("/api/v1/functions/create")));
  assert.ok(calls.some((c) => c.endsWith("/valves/update")));
});

test("provisionFilter() updates function if it already exists", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/auths/api_key")) {
      return new Response(JSON.stringify({ key: "api-key-xyz" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/functions/id/made_routing")) {
      if (init?.method === "GET") {
        // GET check: function exists
        return new Response(JSON.stringify({ id: "made_routing" }), { status: 200 });
      }
    }
    if (u.endsWith("/id/made_routing/update")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.id, "made_routing");
      assert.equal(body.type, "filter");
      assert.match(body.content, /class Filter/);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.endsWith("/valves/update")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.OPENWEBUI_TOKEN, "api-key-xyz");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await provisionFilter({
    openwebuiUrl: "http://open-webui:8080",
    madeUrl: "http://made:8000",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname,
    classifierModel: "deepseek-v4-flash",
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.endsWith("/id/made_routing/update")));
  assert.ok(calls.some((c) => c.endsWith("/valves/update")));
  assert.ok(!calls.some((c) => c.endsWith("/api/v1/functions/create")));
});

test("provisionFilter() returns ok:false with an error message when sign-in fails", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ detail: "invalid credentials" }), { status: 400 });

  const result = await provisionFilter({
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "wrong",
    filterSourcePath: new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname,
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid credentials|sign-?in failed/i);
});

test("provisionFilter() is idempotent: running it twice produces the same end state", async () => {
  let apiKeyCalls = 0;
  let createCalls = 0;
  let updateCalls = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/auths/api_key")) {
      apiKeyCalls++;
      return new Response(JSON.stringify({ key: "api-key-xyz" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/functions/id/made_routing")) {
      if (init?.method === "GET") {
        // Always return exists after the first call
        return apiKeyCalls > 1
          ? new Response(JSON.stringify({ id: "made_routing" }), { status: 200 })
          : new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
      }
    }
    if (u.endsWith("/api/v1/functions/create")) {
      createCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.endsWith("/id/made_routing/update")) {
      updateCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.endsWith("/valves/update")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const deps = {
    openwebuiUrl: "http://open-webui:8080",
    madeUrl: "http://made:8000",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname,
    classifierModel: "deepseek-v4-flash",
    fetchFn: fakeFetch,
  };

  await provisionFilter(deps);
  await provisionFilter(deps);

  // First run: create + api key. Second run: update + api key
  assert.equal(createCalls, 1);
  assert.equal(updateCalls, 1);
  assert.equal(apiKeyCalls, 2);
});
