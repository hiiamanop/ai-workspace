import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";
import type { ChatMessage } from "../src/types.ts";

test("POST /api/chat returns the handler's result as JSON", async () => {
  const server = createServer(async (messages: ChatMessage[]) => ({
    selectedCandidateId: "gemma4:12b",
    reply: `echo: ${messages[0].content}`,
    toolsUsed: [],
  }));
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { selectedCandidateId: "gemma4:12b", reply: "echo: hi", toolsUsed: [] });
  server.close();
});

test("POST /api/chat with missing messages returns 400", async () => {
  const server = createServer(async (messages: ChatMessage[]) => ({
    selectedCandidateId: "x",
    reply: String(messages.length),
    toolsUsed: [],
  }));
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 400);
  server.close();
});

test("POST /api/chat returns 500 with the error message when the handler throws", async () => {
  const server = createServer(async () => {
    throw new Error("MADE returned no eligible candidate");
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.error, "MADE returned no eligible candidate");
  server.close();
});

test("GET / serves the index page", async (t) => {
  const server = createServer(async () => ({ selectedCandidateId: "x", reply: "y" }));
  server.listen(0);
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/`);
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.ok(body.length > 0);
});
