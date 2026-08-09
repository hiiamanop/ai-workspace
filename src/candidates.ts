import type { CandidateIn } from "./types.ts";

// ponytail: static score estimates (cost/quality/latency/business_risk),
// not measured from real usage yet. Replace with a live score-cache
// (like MADE's own score_cache) once this app has real traffic to learn from.

const OLLAMA_CANDIDATE: CandidateIn = {
  id: "gemma4:12b",
  vendor: "ollama-local",
  kind: "model",
  cost_per_1k_tokens: 0,
  scores: { cost: 0, quality: 0.75, latency: 9000, business_risk: 0.1 },
};

const DEEPSEEK_CANDIDATE: CandidateIn = {
  id: "deepseek-v4-flash",
  vendor: "deepseek",
  kind: "model",
  cost_per_1k_tokens: 0.001,
  scores: { cost: 0.001, quality: 0.9, latency: 15000, business_risk: 0.25 },
};

export function availableCandidates(env: NodeJS.ProcessEnv = process.env): CandidateIn[] {
  const candidates = [OLLAMA_CANDIDATE];
  if (env.DEEPSEEK_API_KEY) {
    candidates.push(DEEPSEEK_CANDIDATE);
  }
  return candidates;
}
