import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_PIPE_SOURCE, provisionAuto } from "../src/openwebui-provision-auto.ts";

test("AUTO_PIPE_SOURCE executes approved search before upstream completion", () => {
  assert.match(AUTO_PIPE_SOURCE, /tool_selection/);
  assert.match(AUTO_PIPE_SOURCE, /\/api\/web-search/);
  assert.match(AUTO_PIPE_SOURCE, /UPSTREAM_BASE_URL/);
  assert.match(AUTO_PIPE_SOURCE, /UPSTREAM_API_KEY/);
});

test("provisionAuto() updates the existing Auto Pipe with the shared token", async () => {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    const path = String(url);
    calls.push(path);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer shared-key");
    if (path.endsWith("/api/v1/functions/id/made_multimodal")) {
      return new Response(JSON.stringify({ id: "made_multimodal" }), { status: 200 });
    }
    if (path.endsWith("/api/v1/functions/id/made_multimodal/update")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.id, "made_multimodal");
      assert.equal(body.type, "pipe");
      assert.match(body.content, /_run_tools/);
      return new Response(JSON.stringify({ id: "made_multimodal" }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${path}`);
  };

  const result = await provisionAuto({
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "secret",
    openwebuiToken: "shared-key",
    fetchFn,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    "http://open-webui:8080/api/v1/functions/id/made_multimodal",
    "http://open-webui:8080/api/v1/functions/id/made_multimodal/update",
  ]);
});
