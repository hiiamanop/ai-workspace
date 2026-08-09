import { test } from "node:test";
import assert from "node:assert/strict";
import { callScrape } from "../../src/mcp/scrapling-client.ts";

test("callScrape() connects, calls the fetch tool with the url, and closes the connection", async () => {
  let capturedName = "";
  let capturedArgs: unknown = null;
  let closed = false;

  const fakeConnect = async () => ({
    callTool: async (name: string, args: Record<string, unknown>) => {
      capturedName = name;
      capturedArgs = args;
      return "page content";
    },
    close: async () => {
      closed = true;
    },
  });

  const result = await callScrape("https://example.com", fakeConnect);

  assert.equal(capturedName, "fetch");
  assert.deepEqual(capturedArgs, { url: "https://example.com" });
  assert.equal(result, "page content");
  assert.equal(closed, true);
});
