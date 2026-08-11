import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, completeStream } from "../../src/providers/ollama-client.ts";
import type { ChatMessage } from "../../src/types.ts";

test("complete() posts messages (and tools, if given) to {baseUrl}/v1/chat/completions", async () => {
  let capturedBody: any = null;
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hello from gemma", tool_calls: undefined } }] }),
      { status: 200 }
    );
  };

  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const result = await complete("gemma4:12b", messages, [], "http://ollama.test", fakeFetch);

  assert.deepEqual(capturedBody, { model: "gemma4:12b", messages });
  assert.deepEqual(result, { content: "hello from gemma", toolCalls: [] });
});

test("complete() includes tools in the request body and surfaces tool_calls in the result", async () => {
  const toolCall = { id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } };
  let capturedBody: any = null;
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "", tool_calls: [toolCall] } }] }),
      { status: 200 }
    );
  };

  const tools = [{ type: "function" as const, function: { name: "web_search", description: "d", parameters: {} } }];
  const result = await complete("gemma4:12b", [{ role: "user", content: "hi" }], tools, "http://ollama.test", fakeFetch);

  assert.deepEqual(capturedBody.tools, tools);
  assert.deepEqual(result, { content: "", toolCalls: [toolCall] });
});

test("complete() throws on non-200 response", async () => {
  const fakeFetch: typeof fetch = async () => new Response("boom", { status: 500 });
  await assert.rejects(
    () => complete("gemma4:12b", [{ role: "user", content: "hi" }], [], "http://ollama.test", fakeFetch),
    /Ollama API returned 500/
  );
});

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("completeStream() forwards content deltas via onDelta as they arrive", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  ];
  const fakeFetch: typeof fetch = async () => sseResponse(chunks);

  const deltas: string[] = [];
  const result = await completeStream(
    "gemma4:12b",
    [{ role: "user", content: "hi" }],
    [],
    { onDelta: (t) => deltas.push(t), onToolCallDelta: () => { throw new Error("should not be called"); } },
    undefined,
    "http://ollama.test",
    fakeFetch
  );

  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.deepEqual(result, { content: "Hello", toolCalls: [] });
});

test("completeStream() reconstructs tool calls from delta fragments and calls onToolCallDelta per fragment", async () => {
  const chunks = [
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search", arguments: "" } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
  ];
  const fakeFetch: typeof fetch = async () => sseResponse(chunks);

  const toolDeltas: { index: number; id?: string; name?: string; argsFragment?: string }[] = [];
  const result = await completeStream(
    "gemma4:12b",
    [{ role: "user", content: "search" }],
    [],
    { onDelta: () => { throw new Error("should not be called"); }, onToolCallDelta: (d) => toolDeltas.push(d) },
    undefined,
    "http://ollama.test",
    fakeFetch
  );

  assert.equal(toolDeltas.length, 3);
  assert.deepEqual(result, {
    content: "",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }],
  });
});

test("completeStream() rejects with AbortError when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const fakeFetch: typeof fetch = async (_url, init) => {
    if (init?.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    return sseResponse([]);
  };

  await assert.rejects(
    () =>
      completeStream(
        "gemma4:12b",
        [{ role: "user", content: "hi" }],
        [],
        { onDelta: () => {}, onToolCallDelta: () => {} },
        controller.signal,
        "http://ollama.test",
        fakeFetch
      ),
    { name: "AbortError" }
  );
});
