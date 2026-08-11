import { estimateContextTokens } from "./token-estimate.ts";
import type { ChatMessage } from "./types.ts";

export function trimHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  let start = 0;
  while (start < messages.length - 1) {
    const candidate = messages.slice(start);
    if (estimateContextTokens("", [], candidate) <= budgetTokens) {
      return candidate;
    }
    start += 1;
  }
  return messages.slice(start);
}
