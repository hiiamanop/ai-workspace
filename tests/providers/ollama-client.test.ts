import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../../src/providers/ollama-client.ts";
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
