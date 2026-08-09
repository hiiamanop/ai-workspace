import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../../src/providers/ollama-client.ts";

test("complete() posts to {baseUrl}/v1/chat/completions and returns the reply text", async () => {
  let capturedUrl = "";
  let capturedBody: any = null;
  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hello from gemma" } }] }),
      { status: 200 }
    );
  };

  const reply = await complete("gemma4:12b", "hi", "http://ollama.test", fakeFetch);

  assert.equal(capturedUrl, "http://ollama.test/v1/chat/completions");
  assert.deepEqual(capturedBody, {
    model: "gemma4:12b",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(reply, "hello from gemma");
});

test("complete() throws on non-200 response", async () => {
  const fakeFetch: typeof fetch = async () => new Response("boom", { status: 500 });
  await assert.rejects(
    () => complete("gemma4:12b", "hi", "http://ollama.test", fakeFetch),
    /Ollama API returned 500/
  );
});
