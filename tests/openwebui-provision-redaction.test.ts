import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionRedactionFilter } from "../src/openwebui-provision-redaction.ts";

test("provisionRedactionFilter() creates the function, toggles it, and sets valves", async () => {
  const calls: string[] = [];
  let toggleActiveCalled = false;
  let toggleGlobalCalled = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/functions/id/confidential_redaction")) {
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    }
    if (u.endsWith("/api/v1/functions/create")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.id, "confidential_redaction");
      assert.equal(body.type, "filter");
      assert.match(body.content, /class Filter/);
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer pre-minted-key");
      return new Response(
        JSON.stringify({ id: "confidential_redaction", is_active: false, is_global: false }),
        { status: 200 }
      );
    }
    if (u.includes("/id/confidential_redaction/toggle")) {
      if (u.includes("/toggle/global")) {
        toggleGlobalCalled = true;
      } else {
        toggleActiveCalled = true;
      }
      return new Response(
        JSON.stringify({ id: "confidential_redaction", is_active: true, is_global: true }),
        { status: 200 }
      );
    }
    if (u.endsWith("/valves/update")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.MADE_URL, "http://made:8000");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await provisionRedactionFilter({
    openwebuiUrl: "http://open-webui:8080",
    madeUrl: "http://made:8000",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/confidential_redaction.py", import.meta.url).pathname,
    openwebuiToken: "pre-minted-key",
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, true);
  assert.ok(!calls.some((c) => c.endsWith("/api/v1/auths/signin")), "should not sign in when a token is supplied");
  assert.ok(calls.some((c) => c.endsWith("/api/v1/functions/create")));
  assert.equal(toggleActiveCalled, true);
  assert.equal(toggleGlobalCalled, true);
  assert.ok(calls.some((c) => c.endsWith("/valves/update")));
});

test("provisionRedactionFilter() updates the function if it already exists, and skips toggles if already active/global", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/functions/id/confidential_redaction") && init?.method === "GET") {
      return new Response(JSON.stringify({ id: "confidential_redaction" }), { status: 200 });
    }
    if (u.endsWith("/id/confidential_redaction/update")) {
      return new Response(
        JSON.stringify({ id: "confidential_redaction", is_active: true, is_global: true }),
        { status: 200 }
      );
    }
    if (u.includes("/id/confidential_redaction/toggle")) {
      throw new Error("toggle should not be called when function is already active/global");
    }
    if (u.endsWith("/valves/update")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await provisionRedactionFilter({
    openwebuiUrl: "http://open-webui:8080",
    madeUrl: "http://made:8000",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/confidential_redaction.py", import.meta.url).pathname,
    openwebuiToken: "pre-minted-key",
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.endsWith("/id/confidential_redaction/update")));
  assert.ok(!calls.some((c) => c.endsWith("/api/v1/functions/create")));
});

test("provisionRedactionFilter() signs in itself when no token is supplied", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123", role: "admin" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/functions/id/confidential_redaction")) {
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    }
    if (u.endsWith("/api/v1/functions/create")) {
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer tok-123");
      return new Response(
        JSON.stringify({ id: "confidential_redaction", is_active: true, is_global: true }),
        { status: 200 }
      );
    }
    if (u.endsWith("/valves/update")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await provisionRedactionFilter({
    openwebuiUrl: "http://open-webui:8080",
    madeUrl: "http://made:8000",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    filterSourcePath: new URL("../openwebui-filters/confidential_redaction.py", import.meta.url).pathname,
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.endsWith("/api/v1/auths/signin")));
});

test("provisionRedactionFilter() returns ok:false with an error message when sign-in fails", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ detail: "invalid credentials" }), { status: 400 });

  const result = await provisionRedactionFilter({
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "wrong",
    filterSourcePath: new URL("../openwebui-filters/confidential_redaction.py", import.meta.url).pathname,
    fetchFn: fakeFetch,
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid credentials|sign-?in failed/i);
});
