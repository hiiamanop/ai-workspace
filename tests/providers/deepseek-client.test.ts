import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../../src/providers/deepseek-client.ts";

test("complete() sends Bearer auth and posts to {baseUrl}/v1/chat/completions", async () => {
  let capturedHeaders: HeadersInit | undefined;
  const fakeFetch: typeof fetch = async (_url, init) => {
    capturedHeaders = init?.headers;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hello from deepseek" } }] }),
      { status: 200 }
    );
  };

  const reply = await complete("deepseek-v4-flash", "hi", "sk-test", "http://deepseek.test", fakeFetch);

  assert.equal((capturedHeaders as Record<string, string>)["authorization"], "Bearer sk-test");
  assert.equal(reply, "hello from deepseek");
});

test("complete() throws if no API key is provided", async () => {
  await assert.rejects(
    () => complete("deepseek-v4-flash", "hi", "", "http://deepseek.test", fetch),
    /DEEPSEEK_API_KEY not set/
  );
});
