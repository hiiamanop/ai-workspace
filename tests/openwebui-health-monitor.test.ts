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

test("checkAndSyncVisibility() activates brand and revokes tier grants when MADE is healthy", async () => {
  const toggled: string[] = [];
  const grantUpdates: Array<{ id: string; grants: unknown }> = [];
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
      const body = JSON.parse(String(init?.body)) as { id: string; access_grants: unknown };
      grantUpdates.push({ id: body.id, grants: body.access_grants });
      return new Response("{}", { status: 200 });
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
  // Tiers should have their grants updated to empty (hidden)
  const tierUpdates = grantUpdates.filter((g) => g.id !== "deepseek");
  assert.equal(tierUpdates.length, 2);
  tierUpdates.forEach((update) => {
    assert.deepEqual(update.grants, []);
  });
});

test("checkAndSyncVisibility() deactivates brand and grants public access to tiers when MADE is unreachable", async () => {
  const toggled: string[] = [];
  const grantUpdates: Array<{ id: string; grants: unknown }> = [];
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
      const body = JSON.parse(String(init?.body)) as { id: string; access_grants: unknown };
      grantUpdates.push({ id: body.id, grants: body.access_grants });
      return new Response("{}", { status: 200 });
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
  // Tiers should have their grants updated to public
  const tierUpdates = grantUpdates.filter((g) => g.id !== "deepseek");
  assert.equal(tierUpdates.length, 1);
  tierUpdates.forEach((update) => {
    assert.deepEqual(update.grants, [
      { principal_type: "anyone", principal_id: "*", permission: "read" },
    ]);
  });
});

test("checkAndSyncVisibility() updates tiers to the correct visibility state each check", async () => {
  // Defensive updating: the monitor ensures the correct state on each check by calling
  // access/update for tiers. This prevents silent grant loss. The first call will set
  // the correct state; subsequent calls with unchanged health status will set it again
  // (idempotent). This is necessary because /list doesn't expose current grant state.
  const grantUpdates: Array<{ id: string; grants: unknown }> = [];
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
      // No toggle expected (brand state already correct)
      throw new Error("Unexpected toggle call");
    }
    if (u.includes("/model/access/update")) {
      const body = JSON.parse(String(init?.body)) as { id: string; access_grants: unknown };
      grantUpdates.push({ id: body.id, grants: body.access_grants });
      return new Response("{}", { status: 200 });
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

  assert.equal(result.changed, true); // Changed because we updated tier grants
  // Tier should have empty grants when MADE is healthy
  assert.equal(grantUpdates.length, 1);
  assert.deepEqual(grantUpdates[0], { id: "deepseek-v4-flash", grants: [] });
});
