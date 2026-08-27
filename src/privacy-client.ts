import { createHash } from "node:crypto";

/**
 * Thin client for MADE's /privacy/* endpoints, used by chat.ts to run the
 * same classify -> redact -> decide -> restore flow the Open WebUI
 * confidential_redaction.py Filter runs for the primary chat surface.
 *
 * Each function caches per (orgId, text) for the process lifetime — the
 * standalone chat page resends trimmed history every turn, so without this
 * every prior message hits MADE again on each turn.
 */

const DEFAULT_MADE_URL = () => process.env.MADE_URL ?? "http://localhost:8000";

// chat.ts has no authenticated user; entity mappings for this surface pool
// under one org id (matches confidential_redaction.py's "anonymous" fallback).
export const CHAT_ORG_ID = "anonymous";

// Kept in sync with openwebui-filters/made_routing.py's BLOCKED_MESSAGE.
export const BLOCKED_MESSAGE =
  "This message looks confidential and can't be safely sent to an external " +
  "model. Remove the sensitive details and try again, or ask an admin to " +
  "configure a trusted model.";

export type DataClassification = "public" | "internal" | "confidential" | "restricted";

const classifyCache = new Map<string, DataClassification>();
const redactCache = new Map<string, { text: string; count: number }>();
const restoreCache = new Map<string, string>();

function key(orgId: string, text: string): string {
  return createHash("sha256").update(`${orgId}\0${text}`).digest("hex");
}

async function post<T>(path: string, body: unknown, madeUrl: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${madeUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    throw new Error(`MADE ${path} returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function classify(
  orgId: string,
  text: string,
  madeUrl: string = DEFAULT_MADE_URL(),
  fetchImpl: typeof fetch = fetch
): Promise<DataClassification> {
  const k = key(orgId, text);
  const cached = classifyCache.get(k);
  if (cached) return cached;
  const { classification } = await post<{ classification: DataClassification }>(
    "/privacy/classify",
    { org_id: orgId, text },
    madeUrl,
    fetchImpl
  );
  classifyCache.set(k, classification);
  return classification;
}

export async function redact(
  orgId: string,
  text: string,
  madeUrl: string = DEFAULT_MADE_URL(),
  fetchImpl: typeof fetch = fetch
): Promise<{ text: string; count: number }> {
  const k = key(orgId, text);
  const cached = redactCache.get(k);
  if (cached) return cached;
  const data = await post<{ redacted_text: string; redaction_count: number }>(
    "/privacy/redact",
    { org_id: orgId, text },
    madeUrl,
    fetchImpl
  );
  const result = { text: data.redacted_text, count: data.redaction_count };
  redactCache.set(k, result);
  return result;
}

export async function restore(
  orgId: string,
  text: string,
  madeUrl: string = DEFAULT_MADE_URL(),
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const k = key(orgId, text);
  const cached = restoreCache.get(k);
  if (cached) return cached;
  const { restored_text } = await post<{ restored_text: string }>(
    "/privacy/restore",
    { org_id: orgId, text },
    madeUrl,
    fetchImpl
  );
  restoreCache.set(k, restored_text);
  return restored_text;
}
