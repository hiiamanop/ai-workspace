import type { ChatMessage, ToolDef, CompletionResult } from "../types.ts";

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) => void;
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function requireKey(apiKey: string, keyName: string): void {
  if (!apiKey) throw new Error(`${keyName} not set`);
}

async function parseSseCompletion(
  response: Response,
  callbacks?: StreamCallbacks,
): Promise<CompletionResult> {
  if (!response.body) throw new Error("OmniRouter returned a streaming response with no body");

  let content = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const decoder = new TextDecoder();
  let buffer = "";
  const processEvent = (event: string): void => {
    const line = event.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    let parsed: { choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
    try {
      parsed = JSON.parse(payload) as typeof parsed;
    } catch (error) {
      throw new Error(`OmniRouter returned malformed streaming JSON: ${(error as Error).message}`);
    }
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      callbacks?.onDelta(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const call = calls.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name = tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
      calls.set(tc.index, call);
      callbacks?.onToolCallDelta({ index: tc.index, id: tc.id, name: tc.function?.name, argsFragment: tc.function?.arguments });
    }
  };
  const processBuffer = (): void => {
    buffer = buffer.replace(/\r\n?/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      processEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    processBuffer();
  }
  buffer += decoder.decode();
  processBuffer();
  if (buffer.trim()) processEvent(buffer);

  return {
    content,
    toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.args },
    })),
  };
}

export async function complete(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  apiKey: string = process.env.OMNIROUTER_API_KEY ?? "",
  baseUrl: string = process.env.OMNIROUTER_BASE_URL ?? "http://localhost:20128/v1",
  fetchImpl: typeof fetch = fetch,
): Promise<CompletionResult> {
  requireKey(apiKey, "OMNIROUTER_API_KEY");
  const body: Record<string, unknown> = { model, messages };
  if (tools.length) body.tools = tools;
  const response = await fetchImpl(endpoint(baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OmniRouter API returned ${response.status}: ${await response.text()}`);
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return parseSseCompletion(response);
  }
  const parsed = await response.json() as { choices?: { message?: { content?: string | null; tool_calls?: CompletionResult["toolCalls"] } }[] };
  const message = parsed.choices?.[0]?.message;

  if (!message) throw new Error("OmniRouter API returned no choices");
  return { content: message.content ?? "", toolCalls: message.tool_calls ?? [] };
}

export async function completeStream(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  apiKey: string = process.env.OMNIROUTER_API_KEY ?? "",
  baseUrl: string = process.env.OMNIROUTER_BASE_URL ?? "http://localhost:20128/v1",
  fetchImpl: typeof fetch = fetch,
): Promise<CompletionResult> {
  requireKey(apiKey, "OMNIROUTER_API_KEY");
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (tools.length) body.tools = tools;
  const response = await fetchImpl(endpoint(baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new Error(`OmniRouter API returned ${response.status}: ${await response.text()}`);
  if (!response.body) throw new Error("OmniRouter API returned a streaming response with no body");

  let content = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const decoder = new TextDecoder();
  let buffer = "";
  const processEvent = (event: string): void => {
    const line = event.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    let parsed: { choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
    try {
      parsed = JSON.parse(payload) as typeof parsed;
    } catch (error) {
      throw new Error(`OmniRouter returned malformed streaming JSON: ${(error as Error).message}`);
    }
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) { content += delta.content; callbacks.onDelta(delta.content); }
    for (const tc of delta.tool_calls ?? []) {
      const call = calls.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name = tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
      calls.set(tc.index, call);
      callbacks.onToolCallDelta({ index: tc.index, id: tc.id, name: tc.function?.name, argsFragment: tc.function?.arguments });
    }
  };
  const processBuffer = (): void => {
    buffer = buffer.replace(/\r\n?/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      processEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    processBuffer();
  }
  buffer += decoder.decode();
  processBuffer();
  if (buffer.trim()) processEvent(buffer);
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } }));
  return { content, toolCalls };
}
