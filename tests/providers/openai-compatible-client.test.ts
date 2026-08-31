import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, completeStream } from "../../src/providers/openai-compatible-client.ts";
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
      JSON.stringify({ choices: [{ message: { content: "hello from router" } }] }),
      { status: 200 }
    );
  };

  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const result = await complete("router-v4-flash", messages, [], "sk-test", "http://router.test", fakeFetch);

  assert.equal((capturedHeaders as Record<string, string>)["authorization"], "Bearer sk-test");
  assert.deepEqual(capturedBody, { model: "router-v4-flash", messages });
  assert.deepEqual(result, { content: "hello from router", toolCalls: [] });
});

test("complete() parses OmniRouter SSE responses even without stream=true", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: "Naruto" } }] }),
    JSON.stringify({ choices: [{ delta: { content: " found" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  ];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.stream, undefined);
    return sseResponse(chunks);
  };

  const result = await complete(
    "router-v4-flash",
    [{ role: "user", content: "search Naruto" }],
    [],
    "sk-test",
    "http://router.test",
    fakeFetch,
  );

  assert.deepEqual(result, { content: "Naruto found", toolCalls: [] });
});

test("complete() throws if no API key is provided", async () => {
  await assert.rejects(
    () => complete("router-v4-flash", [{ role: "user", content: "hi" }], [], "", "http://router.test", fetch),
    /OMNIROUTER_API_KEY not set/
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
    "router-v4-flash",
    [{ role: "user", content: "hi" }],
    [],
    { onDelta: (t) => deltas.push(t), onToolCallDelta: () => { throw new Error("should not be called"); } },
    undefined,
    "sk-test",
    "http://router.test",
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
    "router-v4-flash",
    [{ role: "user", content: "search" }],
    [],
    { onDelta: () => { throw new Error("should not be called"); }, onToolCallDelta: () => {} },
    undefined,
    "sk-test",
    "http://router.test",
    fakeFetch
  );

  assert.deepEqual(result, {
    content: "",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"q":1}' } }],
  });
});

test("completeStream() handles an SSE event without a trailing blank line", async () => {
  const payload = JSON.stringify({ choices: [{ delta: { content: "tail" } }] });
  const fakeFetch: typeof fetch = async () => new Response(`data: ${payload}`, { status: 200 });
  const deltas: string[] = [];

  const result = await completeStream(
    "router-v4-flash",
    [{ role: "user", content: "hi" }],
    [],
    { onDelta: (text) => deltas.push(text), onToolCallDelta: () => {} },
    undefined,
    "sk-test",
    "http://router.test",
    fakeFetch,
  );

  assert.deepEqual(deltas, ["tail"]);
  assert.equal(result.content, "tail");
});

test("completeStream() reports malformed SSE JSON as an OmniRouter error", async () => {
  const fakeFetch: typeof fetch = async () => new Response("data: {not-json}\\n\\n", { status: 200 });

  await assert.rejects(
    () => completeStream(
      "router-v4-flash",
      [{ role: "user", content: "hi" }],
      [],
      { onDelta: () => {}, onToolCallDelta: () => {} },
      undefined,
      "sk-test",
      "http://router.test",
      fakeFetch,
    ),
    /OmniRouter returned malformed streaming JSON/,
  );
});

test("completeStream() throws when OMNIROUTER_API_KEY is not set and no apiKey argument given", async () => {
  const originalKey = process.env.OMNIROUTER_API_KEY;
  delete process.env.OMNIROUTER_API_KEY;
  try {
    await assert.rejects(
      () =>
        completeStream(
          "router-v4-flash",
          [{ role: "user", content: "hi" }],
          [],
          { onDelta: () => {}, onToolCallDelta: () => {} }
        ),
      /OMNIROUTER_API_KEY not set/
    );
  } finally {
    if (originalKey !== undefined) process.env.OMNIROUTER_API_KEY = originalKey;
  }
});
