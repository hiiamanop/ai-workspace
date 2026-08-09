import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";

test("POST /api/chat returns the handler's result as JSON", async () => {
  const server = createServer(async (message: string) => ({
    selectedCandidateId: "gemma4:12b",
    reply: `echo: ${message}`,
  }));
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { selectedCandidateId: "gemma4:12b", reply: "echo: hi" });
  server.close();
});

test("POST /api/chat with missing message returns 400", async () => {
  const server = createServer(async (message: string) => ({
    selectedCandidateId: "x",
    reply: message,
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
    body: JSON.stringify({ message: "hi" }),
  });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.error, "MADE returned no eligible candidate");
  server.close();
});
