const CHARS_PER_TOKEN = 4;
const RESPONSE_TOKEN_BUFFER = 1000;

export function estimateContextTokens(system: string, tools: unknown[], messages: unknown[]): number {
  const charCount = system.length + JSON.stringify(tools).length + JSON.stringify(messages).length;
  return Math.ceil(charCount / CHARS_PER_TOKEN) + RESPONSE_TOKEN_BUFFER;
}
