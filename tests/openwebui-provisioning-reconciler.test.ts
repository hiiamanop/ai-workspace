import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileOnce } from "../src/openwebui-provisioning-reconciler.ts";

const baseDeps = {
  openwebuiUrl: "http://open-webui:8080",
  madeUrl: "http://made:8000",
  adminEmail: "admin@example.com",
  adminPassword: "secret",
  mintApiKeyFn: async () => ({ ok: true as const, apiKey: "shared-key" }),
  provisionRedactionFilterFn: async () => ({ ok: true as const }),
  provisionContentFn: async () => ({ ok: true as const, actions: [] }),
  provisionAutoFn: async () => ({ ok: true as const }),
};

test("reconcileOnce() mints one shared key and calls all four provisioners with it", async () => {
  const filterCalls: unknown[] = [];
  const toolsCalls: unknown[] = [];
  const redactionCalls: unknown[] = [];
  const contentCalls: unknown[] = [];
  const autoCalls: unknown[] = [];

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
    provisionRedactionFilterFn: async (deps) => {
      redactionCalls.push(deps);
      return { ok: true };
    },
    provisionContentFn: async (deps) => {
      contentCalls.push(deps);
      return { ok: true, actions: [] };
    },
    provisionAutoFn: async (deps) => {
      autoCalls.push(deps);
      return { ok: true };
    },
  });

  assert.equal(filterCalls.length, 1);
  assert.equal(toolsCalls.length, 1);
  assert.equal(redactionCalls.length, 1);
  assert.equal(contentCalls.length, 1);
  assert.equal(autoCalls.length, 1);
  assert.equal((filterCalls[0] as { openwebuiUrl: string }).openwebuiUrl, "http://open-webui:8080");
  assert.equal((toolsCalls[0] as { openwebuiUrl: string }).openwebuiUrl, "http://open-webui:8080");
  assert.equal((redactionCalls[0] as { openwebuiUrl: string }).openwebuiUrl, "http://open-webui:8080");
  assert.equal((contentCalls[0] as { openwebuiUrl: string }).openwebuiUrl, "http://open-webui:8080");
  assert.equal((filterCalls[0] as { openwebuiToken: string }).openwebuiToken, "shared-key");
  assert.equal((toolsCalls[0] as { openwebuiToken: string }).openwebuiToken, "shared-key");
  assert.equal((redactionCalls[0] as { openwebuiToken: string }).openwebuiToken, "shared-key");
  assert.equal((contentCalls[0] as { openwebuiToken: string }).openwebuiToken, "shared-key");
  assert.equal((autoCalls[0] as { openwebuiToken: string }).openwebuiToken, "shared-key");
});

test("reconcileOnce() resolves false (not throw) when a provisioner reports failure", async () => {
  const ok = await reconcileOnce({
    ...baseDeps,
    provisionFilterFn: async () => ({ ok: false, error: "signin failed" }),
    provisionToolsFn: async () => ({ ok: false, error: "signin failed", actions: [] }),
    provisionContentFn: async () => ({ ok: false, error: "signin failed", actions: [] }),
  });
  assert.equal(ok, false);
});

test("reconcileOnce() passes the shared key to the Auto Pipe provisioner", async () => {
  let autoCall: { openwebuiToken?: string } | undefined;
  const ok = await reconcileOnce({
    ...baseDeps,
    provisionFilterFn: async () => ({ ok: true }),
    provisionToolsFn: async () => ({ ok: true, actions: [] }),
    provisionRedactionFilterFn: async () => ({ ok: true }),
    provisionContentFn: async () => ({ ok: true, actions: [] }),
    provisionAutoFn: async (deps) => {
      autoCall = deps;
      return { ok: true };
    },
  });
  assert.equal(ok, true);
  assert.equal(autoCall?.openwebuiToken, "shared-key");
});

test("reconcileOnce() skips the legacy Auto Pipe when native mode is selected", async () => {
  let autoCalled = false;
  const ok = await reconcileOnce({
    ...baseDeps,
    enableAutoPipe: false,
    provisionFilterFn: async () => ({ ok: true }),
    provisionToolsFn: async () => ({ ok: true, actions: [] }),
    provisionRedactionFilterFn: async () => ({ ok: true }),
    provisionContentFn: async () => ({ ok: true, actions: [] }),
    provisionAutoFn: async () => {
      autoCalled = true;
      return { ok: true };
    },
  });
  assert.equal(ok, true);
  assert.equal(autoCalled, false);
});

test("reconcileOnce() resolves false when only the redaction filter provisioner fails", async () => {
  const ok = await reconcileOnce({
    ...baseDeps,
    provisionFilterFn: async () => ({ ok: true }),
    provisionToolsFn: async () => ({ ok: true, actions: [] }),
    provisionRedactionFilterFn: async () => ({ ok: false, error: "signin failed" }),
  });
  assert.equal(ok, false);
});

test("reconcileOnce() resolves true when all provisioners succeed", async () => {
  const ok = await reconcileOnce({
    ...baseDeps,
    provisionFilterFn: async () => ({ ok: true }),
    provisionToolsFn: async () => ({ ok: true, actions: [] }),
    provisionRedactionFilterFn: async () => ({ ok: true }),
    provisionContentFn: async () => ({ ok: true, actions: [] }),
  });
  assert.equal(ok, true);
});

test("reconcileOnce() resolves false when minting the shared key fails, without calling any provisioner", async () => {
  const filterCalls: unknown[] = [];
  const toolsCalls: unknown[] = [];
  const redactionCalls: unknown[] = [];
  const contentCalls: unknown[] = [];

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
    provisionRedactionFilterFn: async (deps) => {
      redactionCalls.push(deps);
      return { ok: true };
    },
    provisionContentFn: async (deps) => {
      contentCalls.push(deps);
      return { ok: true, actions: [] };
    },
  });

  assert.equal(ok, false);
  assert.equal(filterCalls.length, 0);
  assert.equal(toolsCalls.length, 0);
  assert.equal(redactionCalls.length, 0);
  assert.equal(contentCalls.length, 0);
});
