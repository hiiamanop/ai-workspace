import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, completeStream } from "../../src/providers/deepseek-client.ts";
import type { ChatMessage } from "../../src/types.ts";

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("complete() sends Bearer auth and posts messages to {baseUrl}/v1/chat/completions", async () => {
  let capturedHeaders: HeadersInit | undefined;
  let capturedBody: any = null;
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedHeaders = init?.headers;
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hello from deepseek" } }] }),
      { status: 200 }
    );
  };

  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const result = await complete("deepseek-v4-flash", messages, [], "sk-test", "http://deepseek.test", fakeFetch);

  assert.equal((capturedHeaders as Record<string, string>)["authorization"], "Bearer sk-test");
  assert.deepEqual(capturedBody, { model: "deepseek-v4-flash", messages });
  assert.deepEqual(result, { content: "hello from deepseek", toolCalls: [] });
});

test("complete() throws if no API key is provided", async () => {
  await assert.rejects(
    () => complete("deepseek-v4-flash", [{ role: "user", content: "hi" }], [], "", "http://deepseek.test", fetch),
    /DEEPSEEK_API_KEY not set/
  );
});

test("completeStream() forwards content deltas via onDelta as they arrive", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  ];
  const fakeFetch: typeof fetch = async () => sseResponse(chunks);

  const deltas: string[] = [];
  const result = await completeStream(
    "deepseek-v4-flash",
    [{ role: "user", content: "hi" }],
    [],
    { onDelta: (t) => deltas.push(t), onToolCallDelta: () => { throw new Error("should not be called"); } },
    undefined,
    "sk-test",
    "http://deepseek.test",
    fakeFetch
  );

  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.deepEqual(result, { content: "Hello", toolCalls: [] });
});

test("completeStream() reconstructs tool calls from delta fragments", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search", arguments: "" } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":1}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
  ];
  const fakeFetch: typeof fetch = async () => sseResponse(chunks);

  const result = await completeStream(
    "deepseek-v4-flash",
    [{ role: "user", content: "search" }],
    [],
    { onDelta: () => { throw new Error("should not be called"); }, onToolCallDelta: () => {} },
    undefined,
    "sk-test",
    "http://deepseek.test",
    fakeFetch
  );

  assert.deepEqual(result, {
    content: "",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"q":1}' } }],
  });
});

test("completeStream() throws when DEEPSEEK_API_KEY is not set and no apiKey argument given", async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await assert.rejects(
      () =>
        completeStream(
          "deepseek-v4-flash",
          [{ role: "user", content: "hi" }],
          [],
          { onDelta: () => {}, onToolCallDelta: () => {} }
        ),
      /DEEPSEEK_API_KEY not set/
    );
  } finally {
    if (originalKey !== undefined) process.env.DEEPSEEK_API_KEY = originalKey;
  }
});
