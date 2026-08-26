import { fileURLToPath } from "node:url";
import { provisionFilter } from "./openwebui-provision.ts";
import { provisionTools } from "./openwebui-provision-tools.ts";

// Runs the same provisioning src/openwebui-provision*.ts's CLI entry points do,
// on an interval instead of requiring a manual re-run after every fresh volume
// or deploy. Idempotent (both provision* functions skip work that's already
// up-to-date), so re-running on a timer is cheap and just keeps Open WebUI's
// Filter/Tools in sync with what's on disk here.
export interface ProvisioningReconcilerDeps {
  openwebuiUrl: string;
  madeUrl?: string;
  adminEmail: string;
  adminPassword: string;
  intervalMs?: number;
  retryIntervalMs?: number;
  provisionFilterFn?: typeof provisionFilter;
  provisionToolsFn?: typeof provisionTools;
}

export async function reconcileOnce(deps: ProvisioningReconcilerDeps): Promise<boolean> {
  const filterSourcePath = fileURLToPath(new URL("../openwebui-filters/made_routing.py", import.meta.url));

  const filterResult = await (deps.provisionFilterFn ?? provisionFilter)({
    openwebuiUrl: deps.openwebuiUrl,
    madeUrl: deps.madeUrl,
    adminEmail: deps.adminEmail,
    adminPassword: deps.adminPassword,
    filterSourcePath,
  });
  if (!filterResult.ok) {
    console.error(`provisioning reconciler: Filter provisioning failed: ${filterResult.error}`);
  }

  const toolsResult = await (deps.provisionToolsFn ?? provisionTools)({
    openwebuiUrl: deps.openwebuiUrl,
    adminEmail: deps.adminEmail,
    adminPassword: deps.adminPassword,
  });
  if (!toolsResult.ok) {
    console.error(`provisioning reconciler: Tools provisioning failed: ${toolsResult.error}`);
  }

  return filterResult.ok && toolsResult.ok;
}

export function startProvisioningReconciler(deps: ProvisioningReconcilerDeps): { stop(): void } {
  const steadyIntervalMs = deps.intervalMs ?? 5 * 60_000;
  // Open WebUI/MADE may not be ready yet right after a fresh restart —
  // depends_on only waits for the container to start, not for it to be
  // accepting connections. Retry sooner than the steady-state interval
  // until the first success, but not so fast that failed retries alone
  // exhaust Open WebUI's own signin rate limit (15 requests per 3 minutes,
  // per email — this cycle signs in twice, once per provisioner): a retry
  // storm that keeps re-triggering that limit would make the outage worse,
  // not better.
  const retryIntervalMs = deps.retryIntervalMs ?? 60_000;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(run, delayMs);
    timer.unref();
  };

  const run = () => {
    reconcileOnce(deps)
      .then((ok) => scheduleNext(ok ? steadyIntervalMs : retryIntervalMs))
      .catch((err: unknown) => {
        console.error("provisioning reconciler cycle failed:", err);
        scheduleNext(retryIntervalMs);
      });
  };

  run(); // don't wait before the first attempt
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
