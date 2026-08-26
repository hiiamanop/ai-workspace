import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileOnce } from "../src/openwebui-provisioning-reconciler.ts";

const baseDeps = {
  openwebuiUrl: "http://open-webui:8080",
  madeUrl: "http://made:8000",
  adminEmail: "admin@example.com",
  adminPassword: "secret",
};

test("reconcileOnce() calls both provisioners with the shared connection info", async () => {
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
