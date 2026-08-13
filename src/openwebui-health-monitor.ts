export interface HealthCheckDeps {
  madeUrl: string;
  openwebuiUrl: string;
  adminToken: string;
  fetchFn?: typeof fetch;
}

export interface HealthCheckResult {
  madeHealthy: boolean;
  changed: boolean;
}

interface OpenWebUiModel {
  id: string;
  is_active: boolean;
  meta?: { made_scores?: { brand?: string } };
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

export async function checkAndSyncVisibility(deps: HealthCheckDeps): Promise<HealthCheckResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const madeHealthy = await isMadeHealthy(deps.madeUrl, fetchFn);

  const listRes = await fetchFn(`${deps.openwebuiUrl}/api/v1/models/list`, {
    headers: { authorization: `Bearer ${deps.adminToken}` },
  });
  const { data: models } = (await listRes.json()) as { data: OpenWebUiModel[] };

  const brandedModels = models.filter((m) => m.meta?.made_scores?.brand);
  const byBrand = new Map<string, OpenWebUiModel[]>();
  for (const m of brandedModels) {
    const brand = m.meta!.made_scores!.brand!;
    byBrand.set(brand, [...(byBrand.get(brand) ?? []), m]);
  }

  let changed = false;
  for (const brandModels of byBrand.values()) {
    // Heuristic: the brand entry is the one whose id matches its own brand string;
    // every other model in the group is a tier.
    for (const m of brandModels) {
      const isBrandEntry = m.id === m.meta!.made_scores!.brand;
      const wantActive = isBrandEntry ? madeHealthy : !madeHealthy;
      if (m.is_active !== wantActive) {
        changed = true;
        await fetchFn(`${deps.openwebuiUrl}/api/v1/models/model/toggle?id=${encodeURIComponent(m.id)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.adminToken}` },
        });
      }
    }
  }

  return { madeHealthy, changed };
}

export function startHealthMonitor(deps: HealthCheckDeps & { intervalMs?: number }): { stop(): void } {
  const intervalMs = deps.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    checkAndSyncVisibility(deps).catch((err) => console.error("health monitor cycle failed:", err));
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
