export interface TaskIn {
  type: string;
  data_classification: "public" | "internal" | "confidential" | "restricted";
  estimated_context_tokens?: number;
  // Set true by a caller that ran the text through MADE's /privacy/redact —
  // how external_vendor.rego's deny gate is satisfied for confidential data.
  redacted?: boolean;
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
  context_window_tokens?: number;
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

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
}
