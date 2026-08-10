# Milestone 3 UI Foundation (React + Univer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static HTML chat page with a React frontend built with Vite, and add a second page that mounts Univer's free/open-source Docs editor with a locally-editable (not persisted, not AI-triggered) blank document.

**Architecture:** A new `client/` directory holds a Vite + React + TypeScript frontend with two entry points (`chat.html`, `document.html`), built separately from the existing backend (`src/`, compiled by `tsc` as before). `src/server.ts` is updated to serve `client/dist/` via a small generic static-file handler instead of the old single-file `public/index.html` serving. No backend logic (`src/chat.ts`, MCP clients, MADE integration) changes at all in this plan.

**Tech Stack:** React 19, Vite 8, `@vitejs/plugin-react`, `@univerjs/presets` + `@univerjs/preset-docs-core` (free/open-source Univer Docs only — no Pro/collaboration packages). Backend stack unchanged (Node.js 22+, TypeScript, `tsx`, native `node:http`).

## Global Constraints

- **Univer free tier only.** Do not add `@univerjs/preset-docs-collaboration`, `@univerjs/preset-docs-advanced`, or any package/license key associated with Univer Pro. Only `@univerjs/presets` and `@univerjs/preset-docs-core` are used in this plan.
- No client-side router library (e.g. react-router) — two static Vite entry points (`chat.html`, `document.html`) are enough; do not add routing infrastructure for two pages.
- No backend logic changes — `src/chat.ts`, `src/mcp/*`, `src/made-client.ts`, `src/candidates.ts`, `src/tools.ts` must be byte-for-byte unchanged by this plan.
- No automated test suite for the new React components (per the design spec — this sub-project's scope is proven by manual verification, not unit tests). Backend `node:test` suite must stay green and unaffected throughout.
- Exact package versions (confirmed against the npm registry directly, not guessed): `react@^19.2.8`, `react-dom@^19.2.8`, `vite@^8.2.1`, `@vitejs/plugin-react@^6.0.5`, `@types/react@^19.2.18`, `@types/react-dom@^19.2.4`, `@univerjs/presets@^0.25.1`, `@univerjs/preset-docs-core@^0.25.1`.

---

### Task 1: Scaffold the Vite + React client and port the chat page

**Files:**
- Create: `vite.config.ts` (repo root)
- Create: `client/chat.html`
- Create: `client/document.html` (placeholder shell only — Univer wiring is Task 2)
- Create: `client/src/vite-env.d.ts`
- Create: `client/tsconfig.json`
- Create: `client/src/chat/main.tsx`
- Create: `client/src/chat/ChatApp.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces: `ChatApp` React component (`client/src/chat/ChatApp.tsx`) — self-contained, talks to the existing `/api/chat` endpoint exactly as the old `public/index.html` did. No other file in this plan imports it.

- [ ] **Step 1: Install the client dependencies**

Run:
```bash
npm install react@^19.2.8 react-dom@^19.2.8
npm install --save-dev vite@^8.2.1 @vitejs/plugin-react@^6.0.5 @types/react@^19.2.18 @types/react-dom@^19.2.4
```
Expected: `package.json` gains these under `dependencies` (react, react-dom) and `devDependencies` (the rest).

- [ ] **Step 2: Create the Vite config**

`vite.config.ts` (repo root):

```typescript
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        chat: resolve(__dirname, "client/chat.html"),
        document: resolve(__dirname, "client/document.html"),
      },
    },
  },
});
```

- [ ] **Step 3: Create the client TypeScript config**

`client/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "types": ["vite/client"]
  },
  "include": ["src", "*.d.ts"]
}
```

This is separate from the repo-root `tsconfig.json` (which only `include`s `src` at the repo root — the existing backend — and is unaffected by anything under `client/`). This client config is for editor/type-check support only; the production build (Task 4) uses `vite build`, which strips types via esbuild without invoking this config directly.

- [ ] **Step 4: Add the Vite env types file**

`client/src/vite-env.d.ts`:

```typescript
/// <reference types="vite/client" />
```

- [ ] **Step 5: Write the chat HTML entry**

`client/chat.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AI Workspace — Chat</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/chat/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Write a placeholder document HTML entry**

`client/document.html` (Task 2 fills in the real content; this task just needs the entry point to exist so the multi-page Vite config in Step 2 resolves):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AI Workspace — Document</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/document/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Write a placeholder document entry script**

`client/src/document/main.tsx` (temporary — Task 2 replaces this with the real Univer mount):

```tsx
document.getElementById("root")!.textContent = "Document editor coming in Task 2.";
```

- [ ] **Step 8: Write the chat entry point**

`client/src/chat/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./ChatApp.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatApp />
  </StrictMode>
);
```

- [ ] **Step 9: Port the chat UI to React**

`client/src/chat/ChatApp.tsx` — a like-for-like port of `public/index.html`'s existing behavior (same layout, same `/api/chat` call shape, same tool-usage summary logic from the hardening rounds):

```tsx
import { useState, type FormEvent } from "react";

interface ChatResponse {
  selectedCandidateId: string;
  reply: string;
  toolsUsed: string[];
}

function summarizeTools(toolsUsed: string[]): string {
  const counts: Record<string, number> = {};
  for (const name of toolsUsed) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
}

export function ChatApp() {
  const [message, setMessage] = useState("");
  const [log, setLog] = useState<string[]>([]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const sent = message;
    setLog((prev) => [...prev, `You: ${sent}`]);
    setMessage("");

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: sent }),
    });
    const body = await res.json();

    if (!res.ok) {
      setLog((prev) => [...prev, `Error: ${body.error}`]);
      return;
    }

    const response = body as ChatResponse;
    let text = `[${response.selectedCandidateId}] ${response.reply}`;
    if (response.toolsUsed && response.toolsUsed.length > 0) {
      text += `\n[tools: ${summarizeTools(response.toolsUsed)}]`;
    }
    setLog((prev) => [...prev, text]);
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "40px auto", padding: "0 16px" }}>
      <h1>AI Workspace — Chat</h1>
      <div
        style={{
          whiteSpace: "pre-wrap",
          border: "1px solid #ccc",
          borderRadius: 8,
          padding: 12,
          minHeight: 200,
          marginBottom: 12,
        }}
      >
        {log.map((entry, i) => (
          <div key={i}>
            {entry}
            {"\n"}
          </div>
        ))}
      </div>
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type a message..."
          autoComplete="off"
          required
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" style={{ padding: "8px 16px" }}>
          Send
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 10: Add the Vite dev script and run it**

In `package.json`'s `scripts`, add:

```json
"dev:client": "vite"
```

Run: `npm run dev` (existing backend, unchanged, in one terminal) and `npm run dev:client` (in another terminal).
Expected: Vite prints a local dev URL (e.g. `http://localhost:5173`). Open `http://localhost:5173/chat.html` in a browser — confirm the page renders with the same layout as the old `public/index.html`, and sending a message gets a real reply from the backend (Vite's dev-server proxy forwards `/api/chat` to `http://localhost:3000`).

- [ ] **Step 11: Commit**

```bash
git add vite.config.ts client package.json package-lock.json
git commit -m "feat: scaffold Vite+React client, port chat UI"
```

---

### Task 2: Add the Univer Docs (free tier) document page

**Files:**
- Modify: `client/src/document/main.tsx` (replace Task 1's placeholder)
- Create: `client/src/document/DocumentApp.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces: `DocumentApp` React component (`client/src/document/DocumentApp.tsx`) — self-contained, mounts a local (unsaved, not AI-triggered) Univer Docs editor. No other file in this plan imports it.
- Consumes: nothing from Task 1 except the already-scaffolded Vite/TS setup.

- [ ] **Step 1: Install the Univer free-tier packages**

Run: `npm install @univerjs/presets@^0.25.1 @univerjs/preset-docs-core@^0.25.1`

Expected: `package.json`'s `dependencies` gains exactly these two packages — **do not** let `npm install` pull in `@univerjs/preset-docs-collaboration` or `@univerjs/preset-docs-advanced`; those are not requested here and are not free-tier packages. Verify after install: `grep -i "preset-docs" package.json` shows only `@univerjs/preset-docs-core` and `@univerjs/presets`.

- [ ] **Step 2: Write the document editor component**

`client/src/document/DocumentApp.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import UniverPresetDocsCoreEnUs from "@univerjs/preset-docs-core/locales/en-US";
import { LocaleType, LogLevel, createUniver, defaultTheme, mergeLocales } from "@univerjs/presets";
import "@univerjs/preset-docs-core/lib/index.css";

const CONTAINER_ID = "univer-container";

export function DocumentApp() {
  const mounted = useRef(false);

  useEffect(() => {
    // Guards against React StrictMode's double-invoked effects in dev,
    // which would otherwise call createUniver() twice on the same container.
    if (mounted.current) return;
    mounted.current = true;

    const { univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: {
        [LocaleType.EN_US]: mergeLocales(UniverPresetDocsCoreEnUs),
      },
      logLevel: LogLevel.WARN,
      theme: defaultTheme,
      presets: [
        UniverDocsCorePreset({
          container: CONTAINER_ID,
        }),
      ],
    });

    univerAPI.createDocument({ title: "Untitled document" });
  }, []);

  return (
    <div style={{ height: "100vh" }}>
      <div id={CONTAINER_ID} style={{ height: "100%" }} />
    </div>
  );
}
```

- [ ] **Step 3: Wire it into the document entry point**

Replace `client/src/document/main.tsx` in full:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocumentApp } from "./DocumentApp.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DocumentApp />
  </StrictMode>
);
```

- [ ] **Step 4: Manually verify the document page**

Run: `npm run dev:client` (if not already running), open `http://localhost:5173/document.html`.
Expected: a full-height Univer document editor renders (toolbar, blank page body). Click into the document and type — confirm text appears and the editor responds normally (bold/italic toolbar buttons work, etc.). No console errors about missing modules or a failed `createUniver` call.

- [ ] **Step 5: Commit**

```bash
git add client package.json package-lock.json
git commit -m "feat: add free-tier Univer Docs editor page"
```

---

### Task 3: Serve the built client from the backend, remove the old static page

**Files:**
- Modify: `src/server.ts`
- Modify: `Dockerfile`
- Modify: `package.json`
- Delete: `public/index.html`
- Delete: `public/` (directory, now empty)

**Interfaces:**
- Consumes: `client/dist/` (Task 1 + 2's build output — does not exist until `vite build` runs, which Task 4 exercises for the first time end-to-end)
- Produces: no new exported functions — `createServer` (existing, `src/server.ts`) keeps its exact signature (`(handleChatFn?: typeof handleChat) => http.Server`), only its internal GET-routing logic changes.

- [ ] **Step 1: Replace the static-serving logic in `server.ts`**

Replace `src/server.ts` in full:

```typescript
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
```

- [ ] **Step 2: Run the existing backend test suite to confirm no regression**

Run: `npm test`
Expected: `tests/server.test.ts`'s existing tests still pass — they test `/api/chat` behavior and don't depend on `public/`. The one test named `"GET / serves the index page"` (from Milestone 1) will need inspection: if it asserts specific content from the old static `public/index.html`, it will now fail because `client/dist/chat.html` doesn't exist yet (Task 4 builds it) — read `tests/server.test.ts` first; if that test reads a fixture file directly rather than asserting exact byte content, it may still pass structurally. If it fails because `client/dist/chat.html` is missing, that is EXPECTED at this point in the plan (Task 4's build step creates it) — note it as a known, temporary failure in this task's report rather than trying to fix it here.

- [ ] **Step 3: Update the Dockerfile**

Replace `Dockerfile` in full:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY client ./client
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

- [ ] **Step 4: Update the build script**

In `package.json`, change the `build` script from `"tsc"` to:

```json
"build": "tsc && vite build"
```

- [ ] **Step 5: Remove the old static page**

```bash
git rm public/index.html
rmdir public
```

- [ ] **Step 6: Commit**

```bash
git add src/server.ts Dockerfile package.json
git commit -m "feat: serve built client from backend, remove old static page"
```

---

### Task 4: End-to-end production build verification

No new files — proves the whole chain (client build → server static serving → Docker image) works for real, matching this project's established practice of manual verification against the actual running artifact, not just dev-mode.

- [ ] **Step 1: Full production build**

Run: `npm run build`
Expected: `tsc` compiles the backend to `dist/` (unchanged), then `vite build` compiles the client to `client/dist/`, producing `client/dist/chat.html`, `client/dist/document.html`, and an `assets/` subdirectory with hashed JS/CSS bundles. No build errors.

- [ ] **Step 2: Run the backend test suite again**

Run: `npm test`
Expected: ALL tests pass now, including the one flagged as expected-to-fail in Task 3 Step 2 — `client/dist/chat.html` now exists after Step 1's build.

- [ ] **Step 3: Start the production server and verify both pages**

Run: `npm start`
Expected: server listens on port 3000.

Run: `curl -s http://localhost:3000/ -o /dev/null -w "%{http_code}\n"` — expect `200`.
Run: `curl -s http://localhost:3000/document -o /dev/null -w "%{http_code}\n"` — expect `200`.

Open `http://localhost:3000/` in a browser — confirm the chat page works exactly as before (send a message, get a reply, including the `[tools: ...]` summary if a tool-using message is sent while MADE/Ollama/etc. are running).
Open `http://localhost:3000/document` in a browser — confirm the Univer Docs editor renders and accepts typed input, same as Task 2's dev-mode check.

- [ ] **Step 4: Verify the Docker image builds and serves both pages**

Run: `docker build -t ai-workspace-ui-test .`
Expected: image builds successfully (this exercises `npm run build` inside the container, including the client build — confirms nothing in this plan silently depended on a dev-only file or host-specific path).

Run: `docker run --rm -d -p 3001:3000 --name ai-workspace-ui-test ai-workspace-ui-test`
Run: `curl -s http://localhost:3001/ -o /dev/null -w "%{http_code}\n"` — expect `200`.
Run: `curl -s http://localhost:3001/document -o /dev/null -w "%{http_code}\n"` — expect `200`.
Run: `docker stop ai-workspace-ui-test`

- [ ] **Step 5: Confirm no Univer Pro packages leaked in**

Run: `grep -i "collaboration\|advanced" package.json`
Expected: no output — confirms only the free-tier `@univerjs/preset-docs-core` and `@univerjs/presets` packages are present, matching the Global Constraints.

- [ ] **Step 6: Record the result**

If any step fails, fix the root cause before considering this sub-project done — do not proceed to the next Milestone 3 sub-project (AI-triggered document creation) on a foundation that only half-works.
