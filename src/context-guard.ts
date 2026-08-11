import type { CandidateIn, DecideRequest, DecideResponse } from "./types.ts";

export type CapacityCheckResult =
  | { status: "ok" }
  | { status: "switched"; candidate: CandidateIn }
  | { status: "exhausted" };

export async function ensureCandidateFits(
  current: CandidateIn,
  candidates: CandidateIn[],
  estimatedTokens: number,
  decide: (request: DecideRequest) => Promise<DecideResponse>
): Promise<CapacityCheckResult> {
  if (!current.context_window_tokens || estimatedTokens <= current.context_window_tokens) {
    return { status: "ok" };
  }

  const decision = await decide({
    task: {
      type: "chat",
      data_classification: "internal",
      estimated_context_tokens: estimatedTokens,
    },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: "model_selection",
    candidates,
    policy_set: "default",
  });

  if (!decision.selected_candidate_id || decision.requires_human_approval) {
    return { status: "exhausted" };
  }

  const next = candidates.find((c) => c.id === decision.selected_candidate_id);
  if (!next) {
    return { status: "exhausted" };
  }

  return { status: "switched", candidate: next };
}
