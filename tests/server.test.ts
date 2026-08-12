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

test("WS: chat turn streams delta events then a done event", async () => {
  const server = createServer(async (_messages: ChatMessage[], _deps, streamCallbacks) => {
    streamCallbacks?.onDelta("hel");
    streamCallbacks?.onDelta("lo");
    return { selectedCandidateId: "x", reply: "hello", toolsUsed: [] };
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const events: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hi" }] }));
    });
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data.toString());
      events.push(msg);
      if (msg.type === "done") resolve();
    });
    ws.addEventListener("error", reject);
  });
  ws.close();
  server.close();

  const types = events.filter((e) => e.type !== "turn_started").map((e) => e.type);
  assert.deepEqual(types, ["delta", "delta", "done"]);
});

test("WS: chat turn emits a sources event when the handler's streamCallbacks.onSources fires", async () => {
  const server = createServer(async (_messages: ChatMessage[], _deps, streamCallbacks) => {
    streamCallbacks?.onSources?.([{ title: "T", url: "https://x.example", snippet: "s" }]);
    streamCallbacks?.onDelta("done");
    return { selectedCandidateId: "x", reply: "done", toolsUsed: [] };
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const events: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hi" }] }));
    });
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data.toString());
      events.push(msg);
      if (msg.type === "done") resolve();
    });
    ws.addEventListener("error", reject);
  });
  ws.close();
  server.close();

  const sourcesEvent = events.find((e) => e.type === "sources");
  assert.ok(sourcesEvent);
  assert.deepEqual(sourcesEvent.results, [{ title: "T", url: "https://x.example", snippet: "s" }]);
});

test("POST /api/web-search returns structured results as JSON", async () => {
  const server = createServer(
    async () => ({ selectedCandidateId: "x", reply: "y", toolsUsed: [] }),
    undefined,
    async (query: string, maxResults?: number) => ({
      results: [{ title: `result for ${query}`, url: "https://x.example", snippet: `max ${maxResults ?? "default"}` }],
    })
  );
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/web-search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "jakarta weather", maxResults: 3 }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    results: [{ title: "result for jakarta weather", url: "https://x.example", snippet: "max 3" }],
  });
  server.close();
});

test("POST /api/web-search with missing query returns 400", async () => {
  const server = createServer(async () => ({ selectedCandidateId: "x", reply: "y", toolsUsed: [] }));
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/web-search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 400);
  server.close();
});

test("POST /api/web-search returns 500 with the error message when the search executor throws", async () => {
  const server = createServer(
    async () => ({ selectedCandidateId: "x", reply: "y", toolsUsed: [] }),
    undefined,
    async () => {
      throw new Error("searxng unreachable");
    }
  );
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/api/web-search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "x" }),
  });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.error, "searxng unreachable");
  server.close();
});

test("WS: resume replays buffered events after reconnecting with a new socket", async () => {
  let releaseSecondDelta: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseSecondDelta = resolve;
  });

  const server = createServer(async (_messages: ChatMessage[], _deps, streamCallbacks) => {
    streamCallbacks?.onDelta("first");
    await gate;
    streamCallbacks?.onDelta("second");
    return { selectedCandidateId: "x", reply: "first second", toolsUsed: [] };
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
  let turnId = "";
  let lastSeq = -1;
  await new Promise<void>((resolve) => {
    ws1.addEventListener("open", () =>
      ws1.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hi" }] }))
    );
    ws1.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data.toString());
      if (msg.type === "turn_started") turnId = msg.turnId;
      if (msg.type === "delta") {
        lastSeq = msg.seq;
        resolve();
      }
    });
  });
  ws1.close();
  releaseSecondDelta();

  const ws2 = new WebSocket(`ws://localhost:${port}/ws`);
  const resumedEvents: any[] = [];
  await new Promise<void>((resolve) => {
    ws2.addEventListener("open", () => ws2.send(JSON.stringify({ type: "resume", turnId, lastSeq })));
    ws2.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data.toString());
      resumedEvents.push(msg);
      if (msg.type === "done") resolve();
    });
  });
  ws2.close();
  server.close();

  assert.deepEqual(resumedEvents.map((e) => e.type), ["delta", "done"]);
  assert.equal(resumedEvents[0].text, "second");
});

test("WS: stop aborts an in-flight turn and the done event reports stopped:true", async () => {
  const server = createServer(async (_messages: ChatMessage[], _deps, streamCallbacks) => {
    streamCallbacks?.onDelta("partial");
    await new Promise((_resolve, reject) => {
      streamCallbacks?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
    return { selectedCandidateId: "x", reply: "unreachable", toolsUsed: [] };
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const events: any[] = [];
  let turnId = "";
  await new Promise<void>((resolve) => {
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "chat", messages: [{ role: "user", content: "hi" }] }))
    );
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data.toString());
      events.push(msg);
      if (msg.type === "turn_started") turnId = msg.turnId;
      if (msg.type === "delta") ws.send(JSON.stringify({ type: "stop", turnId }));
      if (msg.type === "done") resolve();
    });
  });
  ws.close();
  server.close();

  const done = events.find((e) => e.type === "done");
  assert.equal(done.stopped, true);
});
