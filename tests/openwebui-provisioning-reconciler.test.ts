import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileOnce } from "../src/openwebui-provisioning-reconciler.ts";

const baseDeps = {
  openwebuiUrl: "http://open-webui:8080",
  madeUrl: "http://made:8000",
  adminEmail: "admin@example.com",
  adminPassword: "secret",
  mintApiKeyFn: async () => ({ ok: true as const, apiKey: "shared-key" }),
};

test("reconcileOnce() mints one shared key and calls both provisioners with it", async () => {
  const filterCalls: unknown[] = [];
  const toolsCalls: unknown[] = [];

  await reconcileOnce({
    ...baseDeps,
    provisionFilterFn: async (deps) => {
      filterCalls.push(deps);
      return { ok: true };
    },
    provisionToolsFn: async (deps) => {
      toolsCalls.push(deps);
      return { ok: true, actions: [] };
    },
  });

  assert.equal(filterCalls.length, 1);
  assert.equal(toolsCalls.length, 1);
  assert.equal((filterCalls[0] as { openwebuiUrl: string }).openwebuiUrl, "http://open-webui:8080");
  assert.equal((toolsCalls[0] as { openwebuiUrl: string }).openwebuiUrl, "http://open-webui:8080");
  assert.equal((filterCalls[0] as { openwebuiToken: string }).openwebuiToken, "shared-key");
  assert.equal((toolsCalls[0] as { openwebuiToken: string }).openwebuiToken, "shared-key");
});

test("reconcileOnce() resolves false (not throw) when a provisioner reports failure", async () => {
  const ok = await reconcileOnce({
    ...baseDeps,
    provisionFilterFn: async () => ({ ok: false, error: "signin failed" }),
    provisionToolsFn: async () => ({ ok: false, error: "signin failed", actions: [] }),
  });
  assert.equal(ok, false);
});

test("reconcileOnce() resolves true when both provisioners succeed", async () => {
  const ok = await reconcileOnce({
    ...baseDeps,
    provisionFilterFn: async () => ({ ok: true }),
    provisionToolsFn: async () => ({ ok: true, actions: [] }),
  });
  assert.equal(ok, true);
});

test("reconcileOnce() resolves false when minting the shared key fails, without calling either provisioner", async () => {
  const filterCalls: unknown[] = [];
  const toolsCalls: unknown[] = [];

  const ok = await reconcileOnce({
    ...baseDeps,
    mintApiKeyFn: async () => ({ ok: false, error: "sign-in failed" }),
    provisionFilterFn: async (deps) => {
      filterCalls.push(deps);
      return { ok: true };
    },
    provisionToolsFn: async (deps) => {
      toolsCalls.push(deps);
      return { ok: true, actions: [] };
    },
  });

  assert.equal(ok, false);
  assert.equal(filterCalls.length, 0);
  assert.equal(toolsCalls.length, 0);
});
