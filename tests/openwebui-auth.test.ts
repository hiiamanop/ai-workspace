import { test } from "node:test";
import assert from "node:assert/strict";
import { mintApiKey } from "../src/openwebui-auth.ts";

test("mintApiKey() signs in then returns the minted API key", async () => {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "jwt-1" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/auths/api_key")) {
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer jwt-1");
      return new Response(JSON.stringify({ api_key: "api-key-xyz" }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await mintApiKey({
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    fetchFn,
  });

  assert.deepEqual(result, { ok: true, apiKey: "api-key-xyz" });
  assert.ok(calls.some((c) => c.endsWith("/api/v1/auths/signin")));
  assert.ok(calls.some((c) => c.endsWith("/api/v1/auths/api_key")));
});

test("mintApiKey() falls back to the admin JWT when api_key creation fails", async () => {
  const fetchFn: typeof fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "jwt-1" }), { status: 200 });
    }
    if (u.endsWith("/api/v1/auths/api_key")) {
      return new Response(JSON.stringify({ detail: "disabled" }), { status: 403 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await mintApiKey({
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    fetchFn,
  });

  assert.deepEqual(result, { ok: true, apiKey: "jwt-1" });
});

test("mintApiKey() returns ok:false when sign-in fails", async () => {
  const fetchFn: typeof fetch = async () =>
    new Response(JSON.stringify({ detail: "invalid credentials" }), { status: 400 });

  const result = await mintApiKey({
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "wrong",
    fetchFn,
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid credentials|sign-?in failed/i);
});
