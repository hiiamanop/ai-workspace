import { readFile } from "node:fs/promises";

export interface ProvisionDeps {
  openwebuiUrl: string;
  adminEmail: string;
  adminPassword: string;
  filterSourcePath: string;
  fetchFn?: typeof fetch;
}

export interface ProvisionResult {
  ok: boolean;
  error?: string;
}

export async function provisionFilter(deps: ProvisionDeps): Promise<ProvisionResult> {
  const fetchFn = deps.fetchFn ?? fetch;

  const signinRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: deps.adminEmail, password: deps.adminPassword }),
  });
  const signinBody = (await signinRes.json()) as { token?: string; detail?: string };
  if (!signinRes.ok || !signinBody.token) {
    return { ok: false, error: signinBody.detail ?? `sign-in failed with status ${signinRes.status}` };
  }

  let content: string;
  try {
    content = await readFile(deps.filterSourcePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to read filter source: ${message}` };
  }
  const now = Math.floor(Date.now() / 1000);

  const syncRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${signinBody.token}`,
    },
    body: JSON.stringify({
      functions: [
        {
          id: "made_routing",
          name: "MADE Routing",
          type: "filter",
          content,
          meta: { description: "Routes chat completions through MADE's /decide before dispatch" },
          is_active: true,
          is_global: true,
          created_at: now,
          updated_at: now,
        },
      ],
    }),
  });

  if (!syncRes.ok) {
    const body = (await syncRes.json().catch(() => ({}))) as { detail?: string };
    return { ok: false, error: body.detail ?? `functions/sync failed with status ${syncRes.status}` };
  }

  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const openwebuiUrl = process.env.OPENWEBUI_URL ?? "http://localhost:3001";
  const adminEmail = process.env.OPENWEBUI_ADMIN_EMAIL ?? "";
  const adminPassword = process.env.OPENWEBUI_ADMIN_PASSWORD ?? "";
  const filterSourcePath = new URL("../openwebui-filters/made_routing.py", import.meta.url).pathname;

  provisionFilter({ openwebuiUrl, adminEmail, adminPassword, filterSourcePath }).then((result) => {
    if (!result.ok) {
      console.error(`Provisioning failed: ${result.error}`);
      process.exit(1);
    }
    console.log("MADE-routing Filter provisioned successfully.");
  });
}
