import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../../src/providers/deepseek-client.ts";
import type { ChatMessage } from "../../src/types.ts";

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
