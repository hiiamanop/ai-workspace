import type { CandidateIn } from "./types.ts";

// ponytail: static score estimates (cost/quality/latency/business_risk),
// not measured from real usage yet. Replace with a live score-cache
// (like MADE's own score_cache) once this app has real traffic to learn from.

const DEEPSEEK_CANDIDATE: CandidateIn = {
  id: "deepseek-v4-flash",
  vendor: "deepseek",
  kind: "model",
  cost_per_1k_tokens: 0.001,
  scores: { cost: 0.001, quality: 0.9, latency: 15000, business_risk: 0.25 },
  context_window_tokens: 1_000_000,
};

const WEB_SEARCH_CANDIDATE: CandidateIn = {
  id: "web_search",
  vendor: "mcp-searxng",
  kind: "tool",
  cost_per_1k_tokens: 0,
  scores: { cost: 0, quality: 0.7, latency: 3000, business_risk: 0.2 },
};

const SCRAPE_CANDIDATE: CandidateIn = {
  id: "scrape",
  vendor: "scrapling",
  kind: "tool",
  cost_per_1k_tokens: 0,
  scores: { cost: 0, quality: 0.7, latency: 6000, business_risk: 0.3 },
};

export function availableCandidates(env: NodeJS.ProcessEnv = process.env): CandidateIn[] {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY not set — no model candidates available");
  }
  return [DEEPSEEK_CANDIDATE];
}

export function availableToolCandidates(): CandidateIn[] {
  return [WEB_SEARCH_CANDIDATE, SCRAPE_CANDIDATE];
}
