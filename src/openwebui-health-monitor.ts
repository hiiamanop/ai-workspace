export interface HealthCheckDeps {
  madeUrl: string;
  openwebuiUrl: string;
  adminEmail: string;
  adminPassword: string;
  fetchFn?: typeof fetch;
}

export interface HealthCheckResult {
  madeHealthy: boolean;
  changed: boolean;
  toggleErrors?: string[];
}

interface OpenWebUiModel {
  id: string;
  is_active: boolean;
  meta?: { made_scores?: { brand?: string; cost_per_1k_tokens?: number } };
}

async function isMadeHealthy(madeUrl: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`${madeUrl}/decide`, { method: "GET" });
    // MADE's /decide only accepts POST; a GET reaching it (even a 405) proves the process is up.
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Determine if a model is the brand entry within its brand group.
 * Brand entry: has no cost_per_1k_tokens. Tier entry: has cost_per_1k_tokens.
 */
function isBrandEntry(model: OpenWebUiModel): boolean {
  return model.meta?.made_scores?.cost_per_1k_tokens === undefined;
}

export async function checkAndSyncVisibility(deps: HealthCheckDeps): Promise<HealthCheckResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const errors: string[] = [];

  // Sign in to get a fresh admin token (avoids expiry issues)
  const signinRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: deps.adminEmail, password: deps.adminPassword }),
  });
  const signinBody = (await signinRes.json()) as { token?: string; detail?: string };
  if (!signinRes.ok || !signinBody.token) {
    errors.push(`sign-in failed: ${signinBody.detail ?? `status ${signinRes.status}`}`);
    return { madeHealthy: false, changed: false, toggleErrors: errors };
  }
  const adminToken = signinBody.token;

  const madeHealthy = await isMadeHealthy(deps.madeUrl, fetchFn);

  // Fetch models with pagination (30 per page)
  const allModels: OpenWebUiModel[] = [];
  let page = 1;
  while (true) {
    const listRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/models/list?page=${page}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    if (!listRes.ok) {
      errors.push(`models/list page ${page} failed: status ${listRes.status}`);
      break;
    }
    const body = (await listRes.json()) as { items?: OpenWebUiModel[]; total?: number };
    if (!Array.isArray(body.items)) {
      errors.push(`models/list returned invalid format`);
      break;
    }
    allModels.push(...body.items);
    if (body.items.length < 30 || allModels.length >= (body.total ?? 0)) {
      break;
    }
    page++;
  }

  const brandedModels = allModels.filter((m) => m.meta?.made_scores?.brand);
  const byBrand = new Map<string, OpenWebUiModel[]>();
  for (const m of brandedModels) {
    const brand = m.meta!.made_scores!.brand!;
    byBrand.set(brand, [...(byBrand.get(brand) ?? []), m]);
  }

  let changed = false;
  for (const brandModels of byBrand.values()) {
    for (const m of brandModels) {
      // Only process brand entries; skip tiers entirely (they stay is_active=true with permanent public read grant)
      if (!isBrandEntry(m)) {
        continue;
      }

      // Brand entry: toggle is_active based on MADE health
      const wantActive = madeHealthy;
      if (m.is_active !== wantActive) {
        changed = true;
        const toggleRes = await fetchFn(
          `${deps.openwebuiUrl}/api/v1/models/model/toggle?id=${encodeURIComponent(m.id)}`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${adminToken}` },
          }
        );
        if (!toggleRes.ok) {
          errors.push(`toggle ${m.id} failed: status ${toggleRes.status}`);
        }
      }
    }
  }

  if (changed) {
    console.log(`Health monitor: MADE is now ${madeHealthy ? "healthy" : "unhealthy"}`);
  }

  return { madeHealthy, changed, toggleErrors: errors.length > 0 ? errors : undefined };
}

export function startHealthMonitor(
  deps: HealthCheckDeps & { intervalMs?: number }
): { stop(): void } {
  const intervalMs = deps.intervalMs ?? 60_000;
  let lastKnownHealthy: boolean | undefined;

  const timer = setInterval(async () => {
    try {
      const result = await checkAndSyncVisibility(deps);
      // Track state across ticks to avoid redundant calls next time
      lastKnownHealthy = result.madeHealthy;
    } catch (err) {
      console.error("health monitor cycle failed:", err);
    }
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
