export interface TaskIn {
  type: string;
  data_classification: "public" | "internal" | "confidential" | "restricted";
}

export interface OrgIn {
  budget_remaining_usd: number;
  region: string;
}

export interface CandidateIn {
  id: string;
  vendor: string;
  kind: "model" | "tool";
  cost_per_1k_tokens: number;
  scores: Record<string, number>;
}

export interface DecideRequest {
  task: TaskIn;
  org: OrgIn;
  decision_kind: "model_selection" | "tool_selection" | "human_approval";
  candidates: CandidateIn[];
  policy_set: string;
}

export interface RankingEntryOut {
  id: string;
  score: number;
}

export interface ExcludedOut {
  id: string;
  reason: string;
}

export interface DecideResponse {
  decision_id: string;
  selected_candidate_id: string | null;
  requires_human_approval: boolean;
  ranking: RankingEntryOut[];
  excluded: ExcludedOut[];
  technique_used: string;
  policy_version: string;
}
