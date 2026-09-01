import type { CandidateIn } from "./types.ts";

// Keep this allowlist static: the gateway catalog is not a trust boundary.
// These are the curated OmniRouter routes exposed to MADE. The fallback
// remains available when a premium route is unavailable.
const CURATED_MODELS = [
  ["antigravity/gemini-2.5-flash-lite", 1_048_576, 0.55, 0.25, 0.001],
  ["antigravity/gemini-2.5-flash", 1_048_576, 0.70, 0.30, 0.001],
  ["antigravity/gpt-oss-120b-medium", 131_072, 0.78, 0.35, 0.001],
  ["antigravity/gemini-3-flash-agent", 1_048_576, 0.82, 0.35, 0.001],
  ["antigravity/gemini-3.1-pro-low", 1_048_576, 0.88, 0.40, 0.001],
  ["antigravity/claude-sonnet-4-6", 200_000, 0.92, 0.45, 0.001],
  ["antigravity/claude-opus-4-6-thinking", 200_000, 0.98, 0.60, 0.001],
] as const;

const FALLBACK_MODELS = [
  ["openrouter/minimax/minimax-m3:free", 1_048_576, 0.70, 0.20, 0],
] as const;

type ModelSpec = readonly [id: string, context: number, quality: number, risk: number, cost: number];

function modelCandidate([id, context, quality, risk, cost]: ModelSpec, fallback = false): CandidateIn {
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
  const allowlist = env.OMNIROUTER_MODEL_ALLOWLIST
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const specs: readonly ModelSpec[] = [...CURATED_MODELS, ...FALLBACK_MODELS];
  const selected = allowlist?.length ? specs.filter(([id]) => allowlist.includes(id)) : specs;
  return selected.map((spec) => modelCandidate(spec, spec[0] === FALLBACK_MODELS[0][0]));
}

export function availableToolCandidates(): CandidateIn[] {
  return [
    { id: "web_search", vendor: "mcp-searxng", kind: "tool", cost_per_1k_tokens: 0, scores: { cost: 0, quality: 0.7, latency: 3000, business_risk: 0.2 } },
    { id: "scrape", vendor: "scrapling", kind: "tool", cost_per_1k_tokens: 0, scores: { cost: 0, quality: 0.7, latency: 6000, business_risk: 0.3 } },
  ];
}
