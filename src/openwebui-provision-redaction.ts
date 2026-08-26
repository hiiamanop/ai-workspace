import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Deliberately not sharing code with provisionFilter() in
// openwebui-provision.ts — that one's structure is hardcoded around
// "made_routing" (function id, valve shape with OPENWEBUI_URL/TOKEN) and
// this Filter's valves are simpler (just MADE_URL, no Open WebUI API key
// needed at all). Matches this repo's existing "duplicate rather than
// prematurely abstract near-identical-but-not-quite code" convention.
export interface ProvisionRedactionDeps {
  openwebuiUrl: string;
  madeUrl?: string;
  adminEmail: string;
  adminPassword: string;
  filterSourcePath: string;
  // Reuse the reconciler's shared token when available — Open WebUI holds
  // exactly one API key per user, so minting an independent one here would
  // silently invalidate whatever provisionFilter()/provisionTools() just set
  // (see openwebui-auth.ts). Falls back to a plain signin token (management
  // endpoints accept either) when called standalone, e.g. via the CLI entry
  // point below.
  openwebuiToken?: string;
  fetchFn?: typeof fetch;
}

export interface ProvisionResult {
  ok: boolean;
  error?: string;
}

export async function provisionRedactionFilter(deps: ProvisionRedactionDeps): Promise<ProvisionResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const madeUrl = deps.madeUrl ?? process.env.MADE_URL ?? "http://made:8000";

  let adminToken = deps.openwebuiToken;
  if (!adminToken) {
    const signinRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/auths/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: deps.adminEmail, password: deps.adminPassword }),
    });
    const signinBody = (await signinRes.json()) as { token?: string; detail?: string };
    if (!signinRes.ok || !signinBody.token) {
      return { ok: false, error: signinBody.detail ?? `sign-in failed with status ${signinRes.status}` };
    }
    adminToken = signinBody.token;
  }

  let content: string;
  try {
    content = await readFile(deps.filterSourcePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to read filter source: ${message}` };
  }

  const functionPayload = {
    id: "confidential_redaction",
    name: "Confidential Redaction",
    type: "filter",
    content,
    meta: { description: "Redacts confidential content before it reaches an external model, restores it in the response" },
  };

  const existingRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/id/confidential_redaction`, {
    method: "GET",
    headers: { authorization: `Bearer ${adminToken}` },
  });

  let createOrUpdateRes: Response;
  if (existingRes.ok) {
    createOrUpdateRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/id/confidential_redaction/update`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(functionPayload),
    });
  } else {
    createOrUpdateRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/create`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
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

  const functionBody = (await createOrUpdateRes.json()) as { is_active?: boolean; is_global?: boolean };

  if (functionBody.is_active === false) {
    const toggleActiveRes = await fetchFn(
      `${deps.openwebuiUrl}/api/v1/functions/id/confidential_redaction/toggle`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );
    if (!toggleActiveRes.ok) {
      const body = (await toggleActiveRes.json().catch(() => ({}))) as { detail?: string };
      return { ok: false, error: body.detail ?? `toggle is_active failed with status ${toggleActiveRes.status}` };
    }
  }

  if (functionBody.is_global === false) {
    const toggleGlobalRes = await fetchFn(
      `${deps.openwebuiUrl}/api/v1/functions/id/confidential_redaction/toggle/global`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );
    if (!toggleGlobalRes.ok) {
      const body = (await toggleGlobalRes.json().catch(() => ({}))) as { detail?: string };
      return { ok: false, error: body.detail ?? `toggle is_global failed with status ${toggleGlobalRes.status}` };
    }
  }

  const valvesRes = await fetchFn(
    `${deps.openwebuiUrl}/api/v1/functions/id/confidential_redaction/valves/update`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ MADE_URL: madeUrl }),
    }
  );
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
  const filterSourcePath = fileURLToPath(new URL("../openwebui-filters/confidential_redaction.py", import.meta.url));

  provisionRedactionFilter({ openwebuiUrl, madeUrl, adminEmail, adminPassword, filterSourcePath }).then((result) => {
    if (!result.ok) {
      console.error(`Provisioning failed: ${result.error}`);
      process.exit(1);
    }
    console.log("Confidential-redaction Filter provisioned successfully.");
  });
}
