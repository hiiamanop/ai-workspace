export interface TaskIn {
  type: string;
  data_classification: "public" | "internal" | "confidential" | "restricted";
  estimated_context_tokens?: number;
  complexity?: "low" | "medium" | "high";
  intent?: string;
  needs_tools?: boolean;
  requested_tools?: string[];
  redacted?: boolean;
  operation?: "read" | "draft" | "create" | "update" | "delete" | "publish" | "send" | "deploy";
  approval_granted?: boolean;
  run_id?: string;
  max_steps?: number;
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
  upstream_group?: string;
  capabilities?: { streaming: boolean; tool_calling: boolean };
  fallback?: boolean;
  verified?: boolean;
  operation?: TaskIn["operation"];
  connector_id?: string;
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
