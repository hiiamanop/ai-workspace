import { test } from "node:test";
import assert from "node:assert/strict";
import { callWebSearch } from "../../src/mcp/searxng-client.ts";

const SAMPLE_JSON = JSON.stringify({
  results: [
    { title: "First Result", url: "https://example.com/a", content: "Snippet A", publishedDate: "2024-01-01" },
    { title: "Second Result", url: "https://example.com/b", content: "Snippet B" },
  ],
  answers: ["The direct answer"],
});

test("callWebSearch() calls searxng_web_search with query + json response_format, parses structured results, and closes the connection", async () => {
  let capturedName = "";
  let capturedArgs: unknown = null;
  let closed = false;

  const fakeConnect = async () => ({
    callTool: async (name: string, args: Record<string, unknown>) => {
      capturedName = name;
      capturedArgs = args;
      return SAMPLE_JSON;
    },
    close: async () => {
      closed = true;
    },
  });

  const result = await callWebSearch("weather in Jakarta", undefined, fakeConnect);

  assert.equal(capturedName, "searxng_web_search");
  assert.deepEqual(capturedArgs, { query: "weather in Jakarta", response_format: "json" });
  assert.deepEqual(result, {
    results: [
      { title: "First Result", url: "https://example.com/a", snippet: "Snippet A", publishedDate: "2024-01-01" },
      { title: "Second Result", url: "https://example.com/b", snippet: "Snippet B" },
    ],
    answer: "The direct answer",
  });
  assert.equal(closed, true);
});

test("callWebSearch() passes num_results when maxResults is given", async () => {
  let capturedArgs: unknown = null;
  const fakeConnect = async () => ({
    callTool: async (_name: string, args: Record<string, unknown>) => {
      capturedArgs = args;
      return SAMPLE_JSON;
    },
    close: async () => {},
  });

  await callWebSearch("query", 3, fakeConnect);

  assert.deepEqual(capturedArgs, { query: "query", response_format: "json", num_results: 3 });
});

test("callWebSearch() closes the connection even if the tool call throws", async () => {
  let closed = false;
  const fakeConnect = async () => ({
    callTool: async () => {
      throw new Error("boom");
    },
    close: async () => {
      closed = true;
    },
  });

  await assert.rejects(() => callWebSearch("x", undefined, fakeConnect), /boom/);
  assert.equal(closed, true);
});

test("callWebSearch() throws when the tool returns non-JSON text", async () => {
  const fakeConnect = async () => ({
    callTool: async () => "not json at all",
    close: async () => {},
  });

  await assert.rejects(() => callWebSearch("x", undefined, fakeConnect), /searxng returned non-JSON response/);
});

test("callWebSearch() throws when the parsed JSON has no results array", async () => {
  const fakeConnect = async () => ({
    callTool: async () => JSON.stringify({ answers: [] }),
    close: async () => {},
  });

  await assert.rejects(() => callWebSearch("x", undefined, fakeConnect), /searxng response missing results array/);
});

test("callWebSearch() omits the answer field when there are no answers", async () => {
  const fakeConnect = async () => ({
    callTool: async () => JSON.stringify({ results: [] }),
    close: async () => {},
  });

  const result = await callWebSearch("x", undefined, fakeConnect);

  assert.deepEqual(result, { results: [] });
});
