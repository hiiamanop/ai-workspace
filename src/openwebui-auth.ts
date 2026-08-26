// Open WebUI stores exactly one API key per user — POST /auths/api_key
// overwrites it, it does not append to a list. Minting a fresh one silently
// invalidates whatever valve already holds the old one. Any caller that
// provisions more than one thing in the same run (the Filter and the Tools,
// both needing this same admin key) MUST mint once and share the result —
// two independent mints in one reconcile cycle would each break the other's
// just-applied valve.
export interface MintApiKeyDeps {
  openwebuiUrl: string;
  adminEmail: string;
  adminPassword: string;
  fetchFn?: typeof fetch;
}

export interface MintApiKeyResult {
  ok: boolean;
  apiKey?: string;
  error?: string;
}

export async function mintApiKey(deps: MintApiKeyDeps): Promise<MintApiKeyResult> {
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
  const adminToken = signinBody.token;

  const apiKeyRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/auths/api_key`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (apiKeyRes.ok) {
    const apiKeyBody = (await apiKeyRes.json()) as { api_key?: string };
    if (apiKeyBody.api_key) {
      return { ok: true, apiKey: apiKeyBody.api_key };
    }
  }
  // Fall back to the admin JWT if API key creation fails (e.g. ENABLE_API_KEYS
  // off) — works the same way as a bearer token, just expires (~4 weeks).
  return { ok: true, apiKey: adminToken };
}
