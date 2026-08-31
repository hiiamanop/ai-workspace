import type { CandidateIn } from "./types.ts";

// ponytail: keep the allowlist static; the gateway catalog is not a trust boundary.
const ANTIGRAVITY_MODELS = [
  ["antigravity/gemini-2.5-flash-lite", 1_048_576, 0.55, 0.25],
  ["antigravity/gemini-2.5-flash", 1_048_576, 0.7, 0.3],
  ["antigravity/gemini-3.5-flash-extra-low", 1_048_576, 0.65, 0.25],
  ["antigravity/gemini-3.5-flash-low", 1_048_576, 0.72, 0.3],
  ["antigravity/gemini-3.1-flash-lite", 1_048_576, 0.7, 0.3],
  ["antigravity/gemini-3.6-flash-high", 1_048_576, 0.85, 0.4],
  ["antigravity/gpt-oss-120b-medium", 131_072, 0.78, 0.35],
  ["antigravity/gemini-pro-agent", 1_048_576, 0.9, 0.45],
  ["antigravity/gemini-3-flash-agent", 1_048_576, 0.82, 0.35],
  ["antigravity/gemini-3.1-pro-low", 1_048_576, 0.88, 0.4],
  ["antigravity/claude-sonnet-4-6", 1_048_576, 0.92, 0.45],
  ["antigravity/gemini-3.6-flash-low", 1_048_576, 0.76, 0.3],
  ["antigravity/gemini-3.6-flash-medium", 1_048_576, 0.82, 0.35],
  ["antigravity/claude-opus-4-6-thinking", 1_048_576, 0.98, 0.6],
] as const;

// Minimax is the only fallback that passed live gateway verification.
const FALLBACK_MODELS = [
  ["openrouter/minimax/minimax-m3:free", 1_048_576, 0.7, 0.2],
] as const;

function modelCandidate([id, context, quality, risk]: readonly [string, number, number, number], fallback = false): CandidateIn {
  const cost = fallback ? 0 : 0.001;
  return {
    id,
    vendor: "omnirouter",
    kind: "model",
    cost_per_1k_tokens: cost,
    scores: { cost, quality, latency: fallback ? 0.8 : 0.5, business_risk: risk },
    context_window_tokens: context,
    upstream_group: fallback ? "openrouter" : "antigravity",
    capabilities: { streaming: true, tool_calling: true },
    fallback,
    verified: true,
  };
}

export function availableCandidates(env: NodeJS.ProcessEnv = process.env): CandidateIn[] {
  if (!env.OMNIROUTER_API_KEY) throw new Error("OMNIROUTER_API_KEY not set — no model candidates available");
  return [...ANTIGRAVITY_MODELS.map((m) => modelCandidate(m)), ...FALLBACK_MODELS.map((m) => modelCandidate(m, true))];
}

export function availableToolCandidates(): CandidateIn[] {
  return [
    { id: "web_search", vendor: "mcp-searxng", kind: "tool", cost_per_1k_tokens: 0, scores: { cost: 0, quality: 0.7, latency: 3000, business_risk: 0.2 } },
    { id: "scrape", vendor: "scrapling", kind: "tool", cost_per_1k_tokens: 0, scores: { cost: 0, quality: 0.7, latency: 6000, business_risk: 0.3 } },
  ];
}
