import { test } from "node:test";
import assert from "node:assert/strict";
import { callWebSearch } from "../../src/mcp/searxng-client.ts";

test("callWebSearch() connects, calls the web_search tool with the query, and closes the connection", async () => {
  let capturedName = "";
  let capturedArgs: unknown = null;
  let closed = false;

  const fakeConnect = async () => ({
    callTool: async (name: string, args: Record<string, unknown>) => {
      capturedName = name;
      capturedArgs = args;
      return "search results text";
    },
    close: async () => {
      closed = true;
    },
  });

  const result = await callWebSearch("weather in Jakarta", fakeConnect);

  assert.equal(capturedName, "searxng_web_search");
  assert.deepEqual(capturedArgs, { query: "weather in Jakarta" });
  assert.equal(result, "search results text");
  assert.equal(closed, true);
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

  await assert.rejects(() => callWebSearch("x", fakeConnect), /boom/);
  assert.equal(closed, true);
});
