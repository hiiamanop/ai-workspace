import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleChat } from "./chat.ts";

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
  if (!filePath.startsWith(CLIENT_DIST_DIR)) {
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

export function createServer(handleChatFn: typeof handleChat = handleChat): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/api/chat") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");

        let message: unknown;
        try {
          message = JSON.parse(raw).message;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        if (typeof message !== "string" || message.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "message field is required" }));
          return;
        }

        try {
          const result = await handleChatFn(message);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      if (req.method === "GET") {
        const urlPath = req.url === "/" ? "/chat.html" : req.url === "/document" ? "/document.html" : (req.url ?? "");
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`ai-workspace chat core listening on http://localhost:${port}`);
  });
}
