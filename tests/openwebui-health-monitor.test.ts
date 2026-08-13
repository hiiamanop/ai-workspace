import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAndSyncVisibility } from "../src/openwebui-health-monitor.ts";

function makeModel(
  id: string,
  is_active: boolean,
  brand: string,
  cost_per_1k_tokens?: number
) {
  return {
    id,
    is_active,
    meta: {
      made_scores: {
        brand,
        ...(cost_per_1k_tokens !== undefined && { cost_per_1k_tokens }),
      },
    },
  };
}

test("checkAndSyncVisibility() activates brand when MADE is healthy", async () => {
  const toggled: string[] = [];
  let accessUpdateCalled = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("made:8000") || u.includes("/decide")) return new Response("{}", { status: 200 });
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123" }), { status: 200 });
    }
    if (u.includes("/api/v1/models/list?page=1")) {
      return new Response(
        JSON.stringify({
          items: [
            makeModel("deepseek", false, "deepseek"),
            makeModel("deepseek-v4-flash", true, "deepseek", 0.0005),
            makeModel("deepseek-v4-pro", true, "deepseek", 0.003),
          ],
          total: 3,
        }),
        { status: 200 }
      );
    }
    if (u.includes("/model/toggle")) {
      toggled.push(new URL(u).searchParams.get("id") ?? "");
      return new Response("{}", { status: 200 });
    }
    if (u.includes("/model/access/update")) {
      accessUpdateCalled = true;
      throw new Error("Unexpected access/update call — tiers should never be touched");
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    fetchFn: fakeFetch,
  });

  assert.equal(result.madeHealthy, true);
  assert.equal(result.changed, true);
  // Brand entry should be toggled to active
  assert.deepEqual(toggled, ["deepseek"]);
  // Tiers should never be touched
  assert.equal(accessUpdateCalled, false);
});

test("checkAndSyncVisibility() deactivates brand when MADE is unreachable", async () => {
  const toggled: string[] = [];
  let accessUpdateCalled = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("made:8000")) throw new Error("connection refused");
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123" }), { status: 200 });
    }
    if (u.includes("/api/v1/models/list?page=1")) {
      return new Response(
        JSON.stringify({
          items: [
            makeModel("deepseek", true, "deepseek"),
            makeModel("deepseek-v4-flash", false, "deepseek", 0.0005),
          ],
          total: 2,
        }),
        { status: 200 }
      );
    }
    if (u.includes("/model/toggle")) {
      toggled.push(new URL(u).searchParams.get("id") ?? "");
      return new Response("{}", { status: 200 });
    }
    if (u.includes("/model/access/update")) {
      accessUpdateCalled = true;
      throw new Error("Unexpected access/update call — tiers should never be touched");
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    fetchFn: fakeFetch,
  });

  assert.equal(result.madeHealthy, false);
  assert.equal(result.changed, true);
  // Brand entry should be toggled to inactive
  assert.deepEqual(toggled, ["deepseek"]);
  // Tiers should never be touched
  assert.equal(accessUpdateCalled, false);
});

test("checkAndSyncVisibility() never touches tiers, even when brand state is already correct", async () => {
  const toggled: string[] = [];
  let accessUpdateCalled = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("made:8000") || u.includes("/decide")) return new Response("{}", { status: 200 });
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123" }), { status: 200 });
    }
    if (u.includes("/api/v1/models/list?page=1")) {
      return new Response(
        JSON.stringify({
          items: [
            makeModel("deepseek", true, "deepseek"),
            makeModel("deepseek-v4-flash", false, "deepseek", 0.0005),
          ],
          total: 2,
        }),
        { status: 200 }
      );
    }
    if (u.includes("/model/toggle")) {
      toggled.push(new URL(u).searchParams.get("id") ?? "");
      return new Response("{}", { status: 200 });
    }
    if (u.includes("/model/access/update")) {
      accessUpdateCalled = true;
      throw new Error("Unexpected access/update call — tiers should never be touched");
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const result = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    fetchFn: fakeFetch,
  });

  // Brand is already correct (active when MADE is healthy), so no change
  assert.equal(result.changed, false);
  assert.deepEqual(toggled, []);
  assert.equal(accessUpdateCalled, false);
});

test("checkAndSyncVisibility() regression guard: tier models are never the target of access/update or toggle calls", async () => {
  // This test ensures that tiers are never touched by any network call, regardless of health state.
  // It's a regression guard against reintroducing the removed access-grant logic.
  const tierIds = ["deepseek-v4-flash", "deepseek-v4-pro"];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("made:8000") || u.includes("/decide")) return new Response("{}", { status: 200 });
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123" }), { status: 200 });
    }
    if (u.includes("/api/v1/models/list?page=1")) {
      return new Response(
        JSON.stringify({
          items: [
            makeModel("deepseek", false, "deepseek"),
            makeModel("deepseek-v4-flash", true, "deepseek", 0.0005),
            makeModel("deepseek-v4-pro", true, "deepseek", 0.003),
          ],
          total: 3,
        }),
        { status: 200 }
      );
    }
    if (u.includes("/model/toggle") || u.includes("/model/access/update")) {
      const targetId = new URL(u).searchParams.get("id");
      if (tierIds.includes(targetId ?? "")) {
        throw new Error(`Tier ${targetId} should never be targeted by toggle or access/update`);
      }
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  // Test with MADE healthy
  const resultHealthy = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    fetchFn: fakeFetch,
  });
  assert.equal(resultHealthy.madeHealthy, true);

  // Test with MADE unhealthy
  const unhealthyFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("made:8000")) throw new Error("connection refused");
    if (u.endsWith("/api/v1/auths/signin")) {
      return new Response(JSON.stringify({ token: "tok-123" }), { status: 200 });
    }
    if (u.includes("/api/v1/models/list?page=1")) {
      return new Response(
        JSON.stringify({
          items: [
            makeModel("deepseek", true, "deepseek"),
            makeModel("deepseek-v4-flash", true, "deepseek", 0.0005),
            makeModel("deepseek-v4-pro", true, "deepseek", 0.003),
          ],
          total: 3,
        }),
        { status: 200 }
      );
    }
    if (u.includes("/model/toggle") || u.includes("/model/access/update")) {
      const targetId = new URL(u).searchParams.get("id");
      if (tierIds.includes(targetId ?? "")) {
        throw new Error(`Tier ${targetId} should never be targeted by toggle or access/update`);
      }
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const resultUnhealthy = await checkAndSyncVisibility({
    madeUrl: "http://made:8000",
    openwebuiUrl: "http://open-webui:8080",
    adminEmail: "admin@example.com",
    adminPassword: "pw",
    fetchFn: unhealthyFetch,
  });
  assert.equal(resultUnhealthy.madeHealthy, false);
});
