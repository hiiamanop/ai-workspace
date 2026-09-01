import type { DecideRequest, DecideResponse, ExternalOperation } from "./types.ts";

/** Small adapter used at the last possible boundary before an external write. */
export interface PolicyGateContext {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  policy_set?: string;
  organization_id?: string;
  actor_id?: string;
  budget_remaining_usd?: number;
  region?: string;
}

export async function recheckExternalOperation(
  context: PolicyGateContext,
  request: { connector_id: string; capability: string; operation: ExternalOperation; run_id?: string; approval_granted?: boolean; idempotency_key?: string },
): Promise<{ allowed: boolean; requires_approval: boolean; reason?: string; decision_id?: string; policy_version?: string }> {
  const candidateId = `${request.connector_id}/${request.capability}`;
  let decision: DecideResponse;
  try {
    decision = await context.decide({
      task: { type: "external_operation", data_classification: "internal", operation: request.operation, approval_granted: request.approval_granted ?? false, run_id: request.run_id },
      org: { budget_remaining_usd: context.budget_remaining_usd ?? 1000, region: context.region ?? "us", organization_id: context.organization_id ?? "default", actor_id: context.actor_id ?? "anonymous" },
      decision_kind: "tool_selection",
      candidates: [{ id: candidateId, vendor: request.connector_id, kind: "tool", cost_per_1k_tokens: 0, scores: {}, operation: request.operation, connector_id: request.connector_id }],
      policy_set: context.policy_set ?? "default",
    });
  } catch (error) {
    return { allowed: false, requires_approval: false, reason: `policy unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const excluded = decision.excluded.find((entry) => entry.id === candidateId);
  return {
    allowed: decision.selected_candidate_id === candidateId && !excluded,
    requires_approval: decision.requires_human_approval,
    reason: excluded?.reason ?? (decision.selected_candidate_id === candidateId ? undefined : "candidate was not selected by policy"),
    decision_id: decision.decision_id,
    policy_version: decision.policy_version,
  };
}
