import { decide as defaultDecide } from "./made-client.ts";
import { availableCandidates as defaultAvailableCandidates } from "./candidates.ts";
import { complete as ollamaComplete } from "./providers/ollama-client.ts";
import { complete as deepseekComplete } from "./providers/deepseek-client.ts";
import type { CandidateIn, DecideRequest, DecideResponse } from "./types.ts";

export interface ChatDeps {
  decide: (request: DecideRequest) => Promise<DecideResponse>;
  availableCandidates: () => CandidateIn[];
  completeByProvider: Record<string, (model: string, prompt: string) => Promise<string>>;
}

const defaultDeps: ChatDeps = {
  decide: defaultDecide,
  availableCandidates: defaultAvailableCandidates,
  completeByProvider: {
    "ollama-local": ollamaComplete,
    deepseek: deepseekComplete,
  },
};

export async function handleChat(
  message: string,
  deps: ChatDeps = defaultDeps
): Promise<{ selectedCandidateId: string; reply: string }> {
  const candidates = deps.availableCandidates();

  const decision = await deps.decide({
    task: { type: "chat", data_classification: "internal" },
    org: { budget_remaining_usd: 1000, region: "us" },
    decision_kind: "model_selection",
    candidates,
    policy_set: "default",
  });

  if (!decision.selected_candidate_id) {
    throw new Error("MADE returned no eligible candidate");
  }

  if (decision.requires_human_approval) {
    throw new Error("MADE requires human approval for this request");
  }

  const selected = candidates.find((c) => c.id === decision.selected_candidate_id);
  if (!selected) {
    throw new Error(`MADE selected unknown candidate id ${decision.selected_candidate_id}`);
  }

  const complete = deps.completeByProvider[selected.vendor];
  if (!complete) {
    throw new Error(`no provider client registered for vendor ${selected.vendor}`);
  }

  const reply = await complete(selected.id, message);

  return { selectedCandidateId: selected.id, reply };
}
