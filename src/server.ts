import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { handleChat } from "./chat.ts";
import type { ChatMessage } from "./types.ts";
import { callWebSearch, type WebSearchResponse } from "./mcp/searxng-client.ts";
import { callScrape } from "./mcp/scrapling-client.ts";
import { startHealthMonitor } from "./openwebui-health-monitor.ts";
import { startProvisioningReconciler } from "./openwebui-provisioning-reconciler.ts";
import { compilePolicy, CompileError } from "./openwebui-policy-compiler.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST_DIR = path.join(__dirname, "..", "client", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

async function serveStatic(res: http.ServerResponse, relativePath: string): Promise<boolean> {
  const filePath = path.join(CLIENT_DIST_DIR, relativePath);
  if (filePath !== CLIENT_DIST_DIR && !filePath.startsWith(CLIENT_DIST_DIR + path.sep)) {
    return false;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const MAX_BUFFERED_EVENTS = 500;
const TURN_EVICT_MS = 60_000;

interface BufferedEvent {
  seq: number;
  message: Record<string, unknown>;
}

interface TurnState {
  buffer: BufferedEvent[];
  status: "running" | "done" | "error";
  controller: AbortController;
  socket: WebSocket | null;
}

const turns = new Map<string, TurnState>();

function emit(turnId: string, message: Record<string, unknown>): void {
  const turn = turns.get(turnId);
  if (!turn) return;
  const seq = turn.buffer.length > 0 ? turn.buffer[turn.buffer.length - 1].seq + 1 : 0;
  const full = { ...message, turnId, seq };
  turn.buffer.push({ seq, message: full });
  if (turn.buffer.length > MAX_BUFFERED_EVENTS) {
    turn.buffer.shift();
  }
  if (turn.socket && turn.socket.readyState === turn.socket.OPEN) {
    turn.socket.send(JSON.stringify(full));
  }
}

type IncomingWsMessage =
  | ({ type: "chat" } & { messages: ChatMessage[] })
  | { type: "resume"; turnId: string; lastSeq: number }
  | { type: "stop"; turnId: string };

function startTurn(
  socket: WebSocket,
  msg: { type: "chat"; messages: ChatMessage[] },
  handleChatFn: typeof handleChat
): void {
  const turnId = crypto.randomUUID();
  const controller = new AbortController();
  turns.set(turnId, { buffer: [], status: "running", controller, socket });
  socket.send(JSON.stringify({ type: "turn_started", turnId }));

  const streamCallbacks = {
    onDelta: (text: string) => emit(turnId, { type: "delta", text }),
    onToolCallDelta: (delta: { index: number; id?: string; name?: string; argsFragment?: string }) =>
      emit(turnId, { type: "tool_call_delta", ...delta }),
    onToolResult: (index: number, name: string, result: string) =>
      emit(turnId, { type: "tool_result", index, name, result }),
    onSources: (results: unknown) => emit(turnId, { type: "sources", results }),
    signal: controller.signal,
  };

  const run = handleChatFn(msg.messages, undefined, streamCallbacks);

  run
    .then((result) => {
      const turn = turns.get(turnId);
      if (turn) turn.status = "done";
      emit(turnId, { type: "done", result });
    })
    .catch((err: Error) => {
      const turn = turns.get(turnId);
      if (turn) turn.status = "error";
      if (err.name === "AbortError") {
        emit(turnId, { type: "done", stopped: true });
      } else {
        emit(turnId, { type: "error", error: err.message });
      }
    })
    .finally(() => {
      setTimeout(() => turns.delete(turnId), TURN_EVICT_MS).unref();
    });
}

function attachWebSocketServer(
  server: http.Server,
  handleChatFn: typeof handleChat
): void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw: Buffer) => {
      let msg: IncomingWsMessage;
      try {
        msg = JSON.parse(raw.toString()) as IncomingWsMessage;
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "invalid JSON message" }));
        return;
      }

      if (msg.type === "chat") {
        startTurn(socket, msg, handleChatFn);
      } else if (msg.type === "resume") {
        const turn = turns.get(msg.turnId);
        if (!turn) {
          socket.send(JSON.stringify({ type: "error", error: "turn not found, please retry" }));
          return;
        }
        turn.socket = socket;
        if (turn.buffer.length > 0 && turn.buffer[0].seq > msg.lastSeq + 1) {
          socket.send(JSON.stringify({ type: "error", turnId: msg.turnId, error: "resume gap: some events were lost, please retry" }));
          return;
        }
        for (const event of turn.buffer) {
          if (event.seq > msg.lastSeq) socket.send(JSON.stringify(event.message));
        }
      } else if (msg.type === "stop") {
        turns.get(msg.turnId)?.controller.abort();
      } else {
        socket.send(JSON.stringify({ type: "error", error: `unknown message type ${(msg as { type: string }).type}` }));
      }
    });
  });
}

export function createServer(
  handleChatFn: typeof handleChat = handleChat,
  webSearchExecutorFn: (query: string, maxResults?: number) => Promise<WebSearchResponse> = callWebSearch,
  scrapeExecutorFn: (url: string) => Promise<string> = callScrape
): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/api/chat") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");

        let messages: unknown;
        try {
          messages = JSON.parse(raw).messages;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        if (!Array.isArray(messages) || messages.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "messages field is required" }));
          return;
        }

        try {
          const result = await handleChatFn(messages as ChatMessage[]);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/web-search") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");

        let body: { query?: unknown; maxResults?: unknown };
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        if (typeof body.query !== "string" || body.query.trim() === "") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "query field is required" }));
          return;
        }

        try {
          const maxResults = typeof body.maxResults === "number" ? body.maxResults : undefined;
          const result = await webSearchExecutorFn(body.query, maxResults);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/scrape") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");

        let body: { url?: unknown };
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        if (typeof body.url !== "string" || body.url.trim() === "") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "url field is required" }));
          return;
        }

        try {
          const content = await scrapeExecutorFn(body.url);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ content }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/compile-policy") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");

        let body: { markdown?: unknown };
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        if (typeof body.markdown !== "string" || body.markdown.trim() === "") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "markdown field is required" }));
          return;
        }

        try {
          const result = await compilePolicy(body.markdown);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          const status = err instanceof CompileError ? 400 : 500;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      if (req.method === "GET") {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const urlPath = pathname === "/" ? "/chat.html" : pathname;
        if (await serveStatic(res, urlPath)) {
          return;
        }
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    }
  });

  attachWebSocketServer(server, handleChatFn);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`ai-workspace chat core listening on http://localhost:${port}`);
  });

  const openwebuiAdminEmail = process.env.OPENWEBUI_ADMIN_EMAIL;
  const openwebuiAdminPassword = process.env.OPENWEBUI_ADMIN_PASSWORD;
  if (openwebuiAdminEmail && openwebuiAdminPassword) {
    startHealthMonitor({
      madeUrl: process.env.MADE_URL ?? "http://made:8000",
      openwebuiUrl: process.env.OPENWEBUI_URL ?? "http://open-webui:8080",
      adminEmail: openwebuiAdminEmail,
      adminPassword: openwebuiAdminPassword,
    });
    startProvisioningReconciler({
      madeUrl: process.env.MADE_URL ?? "http://made:8000",
      openwebuiUrl: process.env.OPENWEBUI_URL ?? "http://open-webui:8080",
      adminEmail: openwebuiAdminEmail,
      adminPassword: openwebuiAdminPassword,
    });
  }
}
