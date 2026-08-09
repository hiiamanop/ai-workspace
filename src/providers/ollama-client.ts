import type { ChatMessage, ToolDef, CompletionResult } from "../types.ts";

export async function complete(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  baseUrl: string = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  fetchImpl: typeof fetch = fetch
): Promise<CompletionResult> {
  const body: Record<string, unknown> = { model, messages };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status !== 200) {
    throw new Error(`Ollama API returned ${response.status}: ${await response.text()}`);
  }

  const parsed = (await response.json()) as {
    choices: { message: { content: string | null; tool_calls?: CompletionResult["toolCalls"] } }[];
  };
  const message = parsed.choices[0].message;
  return { content: message.content ?? "", toolCalls: message.tool_calls ?? [] };
}
