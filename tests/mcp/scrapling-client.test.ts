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

test("callScrape() rejects non-http(s) schemes without connecting", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("ftp://example.com/file", fakeConnect), /unsupported scheme/);
  assert.equal(connected, false);
});

test("callScrape() rejects an invalid URL string without connecting", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("not a url", fakeConnect), /not a valid URL/);
  assert.equal(connected, false);
});

test("callScrape() rejects URLs targeting internal service hostnames without connecting", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("http://searxng:8080/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://made:8000/decide", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://localhost/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://host.docker.internal/", fakeConnect), /internal\/private host/);
  assert.equal(connected, false);
});

test("callScrape() rejects URLs targeting private IPv4 ranges without connecting", async () => {
  let connected = false;
  const fakeConnect = async () => {
    connected = true;
    return { callTool: async () => "", close: async () => {} };
  };

  await assert.rejects(() => callScrape("http://192.168.1.5/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://10.0.0.1/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://172.16.0.1/", fakeConnect), /internal\/private host/);
  await assert.rejects(() => callScrape("http://127.0.0.1/", fakeConnect), /internal\/private host/);
  assert.equal(connected, false);
});
