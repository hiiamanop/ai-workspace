import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAndSyncVisibility } from "../src/openwebui-health-monitor.ts";

function fakeModelsList(models: Array<{ id: string; is_active: boolean; brand?: string }>) {
  return { data: models.map((m) => ({ id: m.id, is_active: m.is_active, meta: { made_scores: m.brand ? { brand: m.brand } : {} } })) };
}

test("checkAndSyncVisibility() activates the brand entry and deactivates tiers when MADE is healthy", async () => {
  const toggled: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("made:8000") || u.includes("/decide")) return new Response("{}", { status: 200 });
    if (u.endsWith("/api/v1/models/list")) {
      return new Response(
        JSON.stringify(fakeModelsList([
          { id: "deepseek", is_active: false, brand: "deepseek" },
          { id: "deepseek-v4-flash", is_active: true, brand: "deepseek" },
          { id: "deepseek-v4-pro", is_active: true, brand: "deepseek" },
        ])),
        { status: 200 },
      );
    }
    if (u.includes("/model/toggle")) {
      toggled.push(new URL(u).searchParams.get("id") ?? "");
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminToken: "tok",
    fetchFn: fakeFetch,
  });

  assert.equal(result.madeHealthy, true);
  assert.equal(result.changed, true);
  assert.deepEqual(new Set(toggled), new Set(["deepseek", "deepseek-v4-flash", "deepseek-v4-pro"]));
});

test("checkAndSyncVisibility() activates tiers and deactivates the brand entry when MADE is unreachable", async () => {
  const toggled: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("made:8000")) throw new Error("connection refused");
    if (u.endsWith("/api/v1/models/list")) {
      return new Response(
        JSON.stringify(fakeModelsList([
          { id: "deepseek", is_active: true, brand: "deepseek" },
          { id: "deepseek-v4-flash", is_active: false, brand: "deepseek" },
        ])),
        { status: 200 },
      );
    }
    if (u.includes("/model/toggle")) {
      toggled.push(new URL(u).searchParams.get("id") ?? "");
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminToken: "tok",
    fetchFn: fakeFetch,
  });

  assert.equal(result.madeHealthy, false);
  assert.equal(result.changed, true);
  assert.deepEqual(new Set(toggled), new Set(["deepseek", "deepseek-v4-flash"]));
});

test("checkAndSyncVisibility() does not toggle anything when the current state already matches", async () => {
  const toggled: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("made:8000")) return new Response("{}", { status: 200 });
    if (u.endsWith("/api/v1/models/list")) {
      return new Response(
        JSON.stringify(fakeModelsList([
          { id: "deepseek", is_active: true, brand: "deepseek" },
          { id: "deepseek-v4-flash", is_active: false, brand: "deepseek" },
        ])),
        { status: 200 },
      );
    }
    if (u.includes("/model/toggle")) {
      toggled.push(new URL(u).searchParams.get("id") ?? "");
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminToken: "tok",
    fetchFn: fakeFetch,
  });

  assert.equal(result.changed, false);
  assert.deepEqual(toggled, []);
});
