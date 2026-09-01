import { fileURLToPath } from "node:url";
import { mintApiKey } from "./openwebui-auth.ts";
import { provisionFilter } from "./openwebui-provision.ts";
import { provisionRedactionFilter } from "./openwebui-provision-redaction.ts";
import { provisionTools } from "./openwebui-provision-tools.ts";
import { provisionContent } from "./openwebui-provision-content.ts";
import { provisionAuto } from "./openwebui-provision-auto.ts";

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
  /** Keep the legacy Auto Pipe opt-in; native OpenWebUI tools are the default. */
  enableAutoPipe?: boolean;
  mintApiKeyFn?: typeof mintApiKey;
  provisionFilterFn?: typeof provisionFilter;
  provisionToolsFn?: typeof provisionTools;
  provisionRedactionFilterFn?: typeof provisionRedactionFilter;
  provisionContentFn?: typeof provisionContent;
  provisionAutoFn?: typeof provisionAuto;
}

export async function reconcileOnce(deps: ProvisioningReconcilerDeps): Promise<boolean> {
  const filterSourcePath = fileURLToPath(new URL("../openwebui-filters/made_routing.py", import.meta.url));
  const redactionFilterSourcePath = fileURLToPath(
    new URL("../openwebui-filters/confidential_redaction.py", import.meta.url)
  );

  // Open WebUI holds exactly one API key per user — mint once here and
  // share it with both provisioners. Letting each mint its own would have
  // the second call silently invalidate the key the first one just set
  // (see openwebui-auth.ts).
  const minted = await (deps.mintApiKeyFn ?? mintApiKey)({
    openwebuiUrl: deps.openwebuiUrl,
    adminEmail: deps.adminEmail,
    adminPassword: deps.adminPassword,
  });
  if (!minted.ok || !minted.apiKey) {
    console.error(`provisioning reconciler: failed to mint an Open WebUI API key: ${minted.error}`);
    return false;
  }
  const openwebuiToken = minted.apiKey;

  const filterResult = await (deps.provisionFilterFn ?? provisionFilter)({
    openwebuiUrl: deps.openwebuiUrl,
    madeUrl: deps.madeUrl,
    adminEmail: deps.adminEmail,
    adminPassword: deps.adminPassword,
    filterSourcePath,
    openwebuiToken,
  });
  if (!filterResult.ok) {
    console.error(`provisioning reconciler: Filter provisioning failed: ${filterResult.error}`);
  }

  const toolsResult = await (deps.provisionToolsFn ?? provisionTools)({
    openwebuiUrl: deps.openwebuiUrl,
    adminEmail: deps.adminEmail,
    adminPassword: deps.adminPassword,
    openwebuiToken,
  });
  if (!toolsResult.ok) {
    console.error(`provisioning reconciler: Tools provisioning failed: ${toolsResult.error}`);
  }

  const redactionFilterResult = await (deps.provisionRedactionFilterFn ?? provisionRedactionFilter)({
    openwebuiUrl: deps.openwebuiUrl,
    madeUrl: deps.madeUrl,
    adminEmail: deps.adminEmail,
    adminPassword: deps.adminPassword,
    filterSourcePath: redactionFilterSourcePath,
    openwebuiToken,
  });
  if (!redactionFilterResult.ok) {
    console.error(`provisioning reconciler: Redaction Filter provisioning failed: ${redactionFilterResult.error}`);
  }

  // Prompts/Skills need no valves and only a verified-user token (the shared
  // minted key works — get_current_user accepts sk- API keys), so reuse the
  // same token instead of signing in a third time this cycle.
  const contentResult = await (deps.provisionContentFn ?? provisionContent)({
    openwebuiUrl: deps.openwebuiUrl,
    adminEmail: deps.adminEmail,
    adminPassword: deps.adminPassword,
    openwebuiToken,
  });
  if (!contentResult.ok) {
    console.error(`provisioning reconciler: Content provisioning failed: ${contentResult.error}`);
  }

  let autoOk = true;
  if (deps.enableAutoPipe !== false) {
    const autoResult = await (deps.provisionAutoFn ?? provisionAuto)({
      openwebuiUrl: deps.openwebuiUrl,
      adminEmail: deps.adminEmail,
      adminPassword: deps.adminPassword,
      openwebuiToken,
    });
    autoOk = autoResult.ok;
    if (!autoResult.ok) {
      console.error(`provisioning reconciler: Auto Pipe provisioning failed: ${autoResult.error}`);
    }
  }

  return filterResult.ok && toolsResult.ok && redactionFilterResult.ok && contentResult.ok && autoOk;
}

export function startProvisioningReconciler(deps: ProvisioningReconcilerDeps): { stop(): void } {
  const steadyIntervalMs = deps.intervalMs ?? 5 * 60_000;
  // Open WebUI/MADE may not be ready yet right after a fresh restart —
  // depends_on only waits for the container to start, not for it to be
  // accepting connections. Retry sooner than the steady-state interval
  // until the first success, but not so fast that failed retries alone
  // exhaust Open WebUI's own signin rate limit (15 requests per 3 minutes,
  // per email — this cycle signs in 3 times: once to mint the shared API
  // key, once each inside provisionFilter/provisionTools for their own
  // management-API calls): a retry storm that keeps re-triggering that
  // limit would make the outage worse, not better.
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
