import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mintApiKey } from "./openwebui-auth.ts";

export interface ProvisionDeps {
  openwebuiUrl: string;
  madeUrl?: string;
  adminEmail: string;
  adminPassword: string;
  filterSourcePath: string;
  // Share a pre-minted key when provisioning more than one thing in the
  // same run (see openwebui-auth.ts) — omit to mint one here standalone.
  openwebuiToken?: string;
  fetchFn?: typeof fetch;
}

export interface ProvisionResult {
  ok: boolean;
  error?: string;
}

export async function provisionFilter(deps: ProvisionDeps): Promise<ProvisionResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const madeUrl = deps.madeUrl ?? process.env.MADE_URL ?? "http://made:8000";

  const signinRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: deps.adminEmail, password: deps.adminPassword }),
  });
  const signinBody = (await signinRes.json()) as { token?: string; detail?: string };
  if (!signinRes.ok || !signinBody.token) {
    return { ok: false, error: signinBody.detail ?? `sign-in failed with status ${signinRes.status}` };
  }
  const adminToken = signinBody.token;

  let openwebuiToken = deps.openwebuiToken;
  if (!openwebuiToken) {
    const minted = await mintApiKey({
      openwebuiUrl: deps.openwebuiUrl,
      adminEmail: deps.adminEmail,
      adminPassword: deps.adminPassword,
      fetchFn,
    });
    if (!minted.ok || !minted.apiKey) {
      return { ok: false, error: minted.error ?? "failed to mint an Open WebUI API key" };
    }
    openwebuiToken = minted.apiKey;
  }

  let content: string;
  try {
    content = await readFile(deps.filterSourcePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to read filter source: ${message}` };
  }

  const functionPayload = {
    id: "made_routing",
    name: "MADE Routing",
    type: "filter",
    content,
    meta: { description: "Routes chat completions through MADE's /decide before dispatch" },
  };

  // Check if the function already exists
  const existingRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/id/made_routing`, {
    method: "GET",
    headers: { authorization: `Bearer ${adminToken}` },
  });

  let createOrUpdateRes: Response;
  if (existingRes.ok) {
    // Function exists, update it
    createOrUpdateRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/id/made_routing/update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(functionPayload),
    });
  } else {
    // Function doesn't exist, create it
    createOrUpdateRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(functionPayload),
    });
  }

  if (!createOrUpdateRes.ok) {
    const body = (await createOrUpdateRes.json().catch(() => ({}))) as { detail?: string };
    return {
      ok: false,
      error: body.detail ?? `function create/update failed with status ${createOrUpdateRes.status}`,
    };
  }

  // Parse the create/update response to check is_active and is_global state
  const functionBody = (await createOrUpdateRes.json()) as {
    is_active?: boolean;
    is_global?: boolean;
  };

  // Toggle is_active if the function is not active
  if (functionBody.is_active === false) {
    const toggleActiveRes = await fetchFn(
      `${deps.openwebuiUrl}/api/v1/functions/id/made_routing/toggle`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
      }
    );
    if (!toggleActiveRes.ok) {
      const body = (await toggleActiveRes.json().catch(() => ({}))) as { detail?: string };
      return {
        ok: false,
        error: body.detail ?? `toggle is_active failed with status ${toggleActiveRes.status}`,
      };
    }
  }

  // Toggle is_global if the function is not global
  if (functionBody.is_global === false) {
    const toggleGlobalRes = await fetchFn(
      `${deps.openwebuiUrl}/api/v1/functions/id/made_routing/toggle/global`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
      }
    );
    if (!toggleGlobalRes.ok) {
      const body = (await toggleGlobalRes.json().catch(() => ({}))) as { detail?: string };
      return {
        ok: false,
        error: body.detail ?? `toggle is_global failed with status ${toggleGlobalRes.status}`,
      };
    }
  }

  // Set the valves (configuration) for the Filter
  const valvesRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/id/made_routing/valves/update`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      MADE_URL: madeUrl,
      OPENWEBUI_URL: deps.openwebuiUrl,
      OPENWEBUI_TOKEN: openwebuiToken,
    }),
  });

  if (!valvesRes.ok) {
    const body = (await valvesRes.json().catch(() => ({}))) as { detail?: string };
    return { ok: false, error: body.detail ?? `valves/update failed with status ${valvesRes.status}` };
  }

  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const openwebuiUrl = process.env.OPENWEBUI_URL ?? "http://localhost:3001";
  const madeUrl = process.env.MADE_URL ?? "http://made:8000";
  const adminEmail = process.env.OPENWEBUI_ADMIN_EMAIL ?? "";
  const adminPassword = process.env.OPENWEBUI_ADMIN_PASSWORD ?? "";
  const filterSourcePath = fileURLToPath(new URL("../openwebui-filters/made_routing.py", import.meta.url));

  provisionFilter({ openwebuiUrl, madeUrl, adminEmail, adminPassword, filterSourcePath }).then((result) => {
    if (!result.ok) {
      console.error(`Provisioning failed: ${result.error}`);
      process.exit(1);
    }
    console.log("MADE-routing Filter provisioned successfully.");
  });
}
