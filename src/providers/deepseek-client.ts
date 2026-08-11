import type { ChatMessage, ToolDef, CompletionResult } from "../types.ts";

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) => void;
}

export async function complete(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  apiKey: string = process.env.DEEPSEEK_API_KEY ?? "",
  baseUrl: string = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  fetchImpl: typeof fetch = fetch
): Promise<CompletionResult> {
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY not set");
  }

  const body: Record<string, unknown> = { model, messages };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (response.status !== 200) {
    throw new Error(`DeepSeek API returned ${response.status}: ${await response.text()}`);
  }

  const parsed = (await response.json()) as {
    choices: { message: { content: string | null; tool_calls?: CompletionResult["toolCalls"] } }[];
  };
  const message = parsed.choices[0].message;
  return { content: message.content ?? "", toolCalls: message.tool_calls ?? [] };
}

export async function completeStream(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  apiKey: string = process.env.DEEPSEEK_API_KEY ?? "",
  baseUrl: string = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  fetchImpl: typeof fetch = fetch
): Promise<CompletionResult> {
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY not set");
  }

  const body: Record<string, unknown> = { model, messages, stream: true };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (response.status !== 200) {
    throw new Error(`DeepSeek API returned ${response.status}: ${await response.text()}`);
  }
  if (!response.body) {
    throw new Error("DeepSeek API returned a streaming response with no body");
  }

  let content = "";
  const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const line = rawEvent.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") continue;

      const parsed = JSON.parse(payload) as {
        choices: { delta: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      };
      const delta = parsed.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        callbacks.onDelta(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsByIndex.get(tc.index) ?? { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
          callbacks.onToolCallDelta({ index: tc.index, id: tc.id, name: tc.function?.name, argsFragment: tc.function?.arguments });
        }
      }
    }
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } }));

  return { content, toolCalls };
}
