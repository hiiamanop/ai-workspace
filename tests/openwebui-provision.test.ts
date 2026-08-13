import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionFilter } from "../src/openwebui-provision.ts";

test("provisionFilter() signs in then syncs the Filter's content", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/functions/sync")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.functions[0].id, "made_routing");
      assert.equal(body.functions[0].type, "filter");
      assert.match(body.functions[0].content, /class Filter/);
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer tok-123");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await provisionFilter({
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname,
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.endsWith("/api/v1/auths/signin")));
  assert.ok(calls.some((c) => c.endsWith("/api/v1/functions/sync")));
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

test("provisionFilter() is idempotent: running it twice sends the same sync payload both times", async () => {
  let syncBodies: unknown[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/functions/sync")) {
      syncBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const deps = {
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname,
    fetchFn: fakeFetch,
  };

  await provisionFilter(deps);
  await provisionFilter(deps);

  assert.equal(syncBodies.length, 2);
  assert.deepEqual(syncBodies[0], syncBodies[1]);
});
