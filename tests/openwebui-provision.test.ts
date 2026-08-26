import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionFilter } from "../src/openwebui-provision.ts";

test("provisionFilter() signs in, creates API key, creates function, toggles it, and sets valves", async () => {
  const calls: string[] = [];
  let toggleActiveCalled = false;
  let toggleGlobalCalled = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/auths/api_key")) {
      return new Response(JSON.stringify({ api_key: "api-key-xyz" }), { status: 200 });
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
      // Return function with is_active=false, is_global=false (defaults)
      return new Response(
        JSON.stringify({ id: "made_routing", is_active: false, is_global: false }),
        { status: 200 }
      );
    }
    if (u.includes("/id/made_routing/toggle")) {
      if (u.includes("/toggle/global")) {
        toggleGlobalCalled = true;
      } else {
        toggleActiveCalled = true;
      }
      return new Response(JSON.stringify({ id: "made_routing", is_active: true, is_global: true }), {
        status: 200,
      });
    }
    if (u.endsWith("/valves/update")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.MADE_URL, "http://made:8000");
      assert.equal(body.OPENWEBUI_URL, "http://open-webui:8080");
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
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.endsWith("/api/v1/auths/signin")));
  assert.ok(calls.some((c) => c.endsWith("/api/v1/auths/api_key")));
  assert.ok(calls.some((c) => c.endsWith("/api/v1/functions/create")));
  assert.equal(toggleActiveCalled, true, "toggle is_active should have been called");
  assert.equal(toggleGlobalCalled, true, "toggle is_global should have been called");
  assert.ok(calls.some((c) => c.endsWith("/valves/update")));
});

test("provisionFilter() updates function if it already exists, and calls toggles if needed", async () => {
  const calls: string[] = [];
  let toggleActiveCalled = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/auths/api_key")) {
      return new Response(JSON.stringify({ api_key: "api-key-xyz" }), { status: 200 });
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
      // Return function already active and global
      return new Response(
        JSON.stringify({ id: "made_routing", is_active: true, is_global: true }),
        { status: 200 }
      );
    }
    if (u.includes("/toggle") && u.includes("/id/made_routing/toggle")) {
      toggleActiveCalled = true;
      throw new Error("toggle should not be called when function is already active/global");
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
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.endsWith("/id/made_routing/update")));
  assert.ok(calls.some((c) => c.endsWith("/valves/update")));
  assert.ok(!calls.some((c) => c.endsWith("/api/v1/functions/create")));
  assert.equal(toggleActiveCalled, false, "toggle should not be called when already active/global");
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
  let toggleActiveCalls = 0;
  let toggleGlobalCalls = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/auths/api_key")) {
      apiKeyCalls++;
      return new Response(JSON.stringify({ api_key: "api-key-xyz" }), { status: 200 });
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
      // Return function with is_active=false, is_global=false (defaults)
      return new Response(
        JSON.stringify({ id: "made_routing", is_active: false, is_global: false }),
        { status: 200 }
      );
    }
    if (u.endsWith("/id/made_routing/update")) {
      updateCalls++;
      // Return function already active and global (simulating idempotent behavior)
      return new Response(
        JSON.stringify({ id: "made_routing", is_active: true, is_global: true }),
        { status: 200 }
      );
    }
    if (u.includes("/toggle") && u.includes("/id/made_routing/toggle")) {
      if (u.includes("/toggle/global")) {
        toggleGlobalCalls++;
      } else {
        toggleActiveCalls++;
      }
      return new Response(JSON.stringify({ id: "made_routing", is_active: true, is_global: true }), {
        status: 200,
      });
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
    fetchFn: fakeFetch,
  };

  await provisionFilter(deps);
  await provisionFilter(deps);

  // First run: create (inactive/global=false) + toggles. Second run: update (already active/global) + no toggles
  assert.equal(createCalls, 1);
  assert.equal(updateCalls, 1);
  assert.equal(apiKeyCalls, 2);
  // First run should toggle both; second run should not (already in desired state)
  assert.equal(toggleActiveCalls, 1);
  assert.equal(toggleGlobalCalls, 1);
});
