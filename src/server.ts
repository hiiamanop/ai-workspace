import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleChat } from "./chat.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

export function createServer(handleChatFn: typeof handleChat = handleChat): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
      let raw = "";
      for await (const chunk of req) raw += chunk;

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

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = await readFile(path.join(PUBLIC_DIR, "index.html"), "utf-8");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`ai-workspace chat core listening on http://localhost:${port}`);
  });
}
