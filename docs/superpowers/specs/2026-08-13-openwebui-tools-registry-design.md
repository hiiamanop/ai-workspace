# Spec: D1 — Open WebUI Tools Registry (Web Search + Scrape)

**Date:** 2026-08-13  
**Author (Researcher):** Claude (ai-workspace researcher)  
**Status:** Ready for coder implementation  
**Depends on:** C1 backend (shipped at 0dc6c6a) — our `/api/web-search` and `/api/scrape` endpoints  
**Related Brainstorm:** `docs/superpowers/brainstorms/2026-08-13-openwebui-genoffice-tools.md`

---

## 1. Problem Statement

Open WebUI has a native Tools workspace (Python-based custom tools) and in-app tool picker. Our `web_search` and `scrape` tools (SearXNG/Scrapling) are server-side, hidden from Open WebUI's UI. Users can't discover or invoke them from Open WebUI's chat.

**Goal:** Register our tools as native Open WebUI Tools, making them visible in the Tools workspace and callable from chat.

---

## 2. Scope

**D1 covers TOOLS REGISTRY ONLY:**
- Register `web_search` + `scrape` as Open WebUI native Tools
- Create Tool definitions (Python functions + metadata)
- Wire to existing endpoints (`/api/web-search`, `/api/scrape`)
- Verify tools appear in Open WebUI's tool picker
- Verify tools can be invoked from chat

**Out of scope (D2):**
- GenOffice docs link (sidebar launcher, trivial)
- Full in-app GenOffice embedding
- MADE governance on tools (skip per recommendation)
- Sheets/slides porting

---

## 3. Requirements

### 3.1 Functional Requirements

**FR-1: Web Search Tool Registration**
- Tool ID: `web_search`
- Tool name: "Web Search"
- Description: "Search the web using SearXNG, returns structured results with URLs and summaries"
- Input schema: `{ query: string, language?: string }`
- Output: JSON with `results: [{title, url, snippet, source}]`
- Callable from Open WebUI's chat (user can invoke via tool picker or trigger auto-invocation)

**FR-2: Scrape Tool Registration**
- Tool ID: `scrape`
- Tool name: "Web Scrape"
- Description: "Scrape content from a URL, returns markdown-formatted text"
- Input schema: `{ url: string }`
- Output: JSON with `content: string` (markdown-formatted page content)
- Callable from Open WebUI's chat

**FR-3: Tool Discovery**
- Tools appear in Open WebUI's Workspace → Tools section
- Tools appear in chat's tool picker (when user requests them or model suggests them)
- Tool metadata (name, description) visible in UI

**FR-4: Tool Invocation**
- User/model selects tool from picker
- Tool call with input parameters (`query`, `url`)
- Our backend endpoint (`/api/web-search`, `/api/scrape`) receives the call
- Results returned to chat as structured JSON
- No error if endpoint unreachable (graceful fallback in Open WebUI)

### 3.2 Non-Functional Requirements

**NF-1: Performance**
- Tool registration: instant (one-time, at setup)
- Tool invocation: <5s response time (backend SLA)

**NF-2: Error Handling**
- Endpoint unreachable: Open WebUI handles gracefully (tool appears, but call fails with user message)
- Tool call syntax error: Open WebUI validates, shows error to user
- Backend error (5xx): return 500 with error message to Open WebUI

**NF-3: Security**
- No secrets in tool definitions (no API keys embedded)
- Our endpoints already auth-protected (if needed)
- Open WebUI's native tool sandbox applies (no code injection risk)

---

## 4. Implementation

### 4.1 Tool Definition Format

Open WebUI Tools are Python functions with metadata. Register via API or direct Python class.

**Web Search Tool Definition:**

```python
{
    "id": "web_search",
    "name": "Web Search",
    "type": "function",
    "description": "Search the web using SearXNG. Returns structured results with titles, URLs, and snippets.",
    "meta": {
        "author": "ai-workspace",
        "tags": ["search", "web", "information-retrieval"]
    },
    "valves": {},  # no configuration needed
    "source": """
def web_search(query: str, language: str = "en") -> dict:
    '''Search the web and return structured results.'''
    import requests
    import json
    
    # Call our backend endpoint
    response = requests.post(
        "http://localhost:3000/api/web-search",
        json={"query": query, "language": language},
        timeout=10
    )
    
    if response.status_code == 200:
        results = response.json()
        return {
            "status": "success",
            "results": results.get("results", []),
            "count": len(results.get("results", []))
        }
    else:
        return {
            "status": "error",
            "error": f"Search failed: {response.status_code}"
        }
"""
}
```

**Scrape Tool Definition:**

```python
{
    "id": "scrape",
    "name": "Web Scrape",
    "type": "function",
    "description": "Scrape content from a URL. Returns markdown-formatted text.",
    "meta": {
        "author": "ai-workspace",
        "tags": ["scrape", "web", "content-extraction"]
    },
    "valves": {},
    "source": """
def scrape(url: str) -> dict:
    '''Scrape content from a URL and return as markdown.'''
    import requests
    
    # Call our backend endpoint
    response = requests.post(
        "http://localhost:3000/api/scrape",
        json={"url": url},
        timeout=10
    )
    
    if response.status_code == 200:
        data = response.json()
        return {
            "status": "success",
            "content": data.get("content", ""),
            "url": url
        }
    else:
        return {
            "status": "error",
            "error": f"Scrape failed: {response.status_code}"
        }
"""
}
```

### 4.2 Registration Method

**Option A: Via Provisioning Script (Recommended)**
- Create `src/openwebui-provision-tools.ts` (similar to `openwebui-provision.ts` for the Filter)
- Script reads tool definitions (hardcoded or from JSON file)
- Calls Open WebUI's `POST /api/v1/tools/create` for each tool
- Idempotent: checks if tool exists (GET), creates if not, updates if definition changed
- Run at setup: `node --import tsx src/openwebui-provision-tools.ts`

**Option B: Manual via Open WebUI Admin UI**
- Operator logs into Open WebUI Admin Settings
- Workspace → Tools → "+ New Tool"
- Paste Python function + metadata
- Save and activate

**Recommendation:** Option A (scripted) for repeatability + docker compose automation.

### 4.3 Backend Endpoints (Already Exist)

Our Node server already has:
- `POST /api/web-search` — accept `{ query, language }`, return `{ results: [...] }`
- `POST /api/scrape` — accept `{ url }`, return `{ content }`

No changes needed to backend. Tool definitions just call these endpoints.

---

## 5. Testing Strategy (for coder)

**Unit tests:**
- Tool definition syntax valid (Python parses)
- Tool function signature matches Open WebUI expectations
- Tool calls (mock backend) return expected JSON shape
- Error handling: backend 5xx → tool returns error object

**Integration tests:**
- Register tools via provisioning script
- Verify tools appear in Open WebUI's `/api/v1/tools` list
- Verify tool metadata correct (name, description visible)
- Mock chat invocation: model calls tool → backend receives request → tool returns result

**Manual testing:**
- Start Open WebUI
- Run provisioning script
- Open chat interface
- Check Workspace → Tools (should show "Web Search" + "Web Scrape")
- Test in chat: ask model to search web (triggers tool call)
- Verify result flows back to chat

---

## 6. Error Handling

**Backend unreachable (connection refused):**
- Tool function catches exception
- Returns `{ status: "error", error: "Connection refused" }`
- Open WebUI displays to user: "Tool failed: Connection refused"

**Backend 5xx error:**
- Tool function checks status code
- Returns `{ status: "error", error: "Search failed: 500" }`
- Open WebUI displays error

**Invalid input:**
- Open WebUI validates tool schema before calling
- If validation fails, error shown to user before tool ever runs

**Timeout:**
- Tool function has 10s timeout on requests.post()
- If timeout: catches exception, returns `{ status: "error", error: "Request timeout" }`

---

## 7. Configuration

**CLAUDE.md addition (setup instructions):**

```markdown
## Tools Registration (D1, Admin-only)

After chat/agent infrastructure is up, register web_search + scrape as native Open WebUI Tools:

1. Ensure Open WebUI is running (`docker compose up`)
2. Run provisioning script:
   ```bash
   node --import tsx src/openwebui-provision-tools.ts
   ```
   Automatically creates/updates web_search and scrape Tools in Open WebUI
3. Verify in Open WebUI Admin Settings → Workspace → Tools
   - Should show "Web Search" and "Web Scrape"
   - Both should be active and callable from chat

Re-run the provisioning script anytime tool definitions change in `src/openwebui-provision-tools.ts`.
```

---

## 8. Implementation Notes for Coder

**Checklist:**
- [ ] Create `src/openwebui-provision-tools.ts`
  - Define web_search tool (Python function + metadata)
  - Define scrape tool (Python function + metadata)
  - Implement `provisionTools()` function (idempotent, create/update logic)
  - Wire into CLI (entry point similar to `openwebui-provision.ts`)
- [ ] Tool functions:
  - Call our existing endpoints (`http://localhost:3000/api/web-search`, `/api/scrape`)
  - Handle errors gracefully (return error object, not throw)
  - 10s timeout on requests
- [ ] Test provisioning:
  - Unit: tool definitions valid Python
  - Integration: tools appear in Open WebUI after provisioning
  - Manual: invoke tools from chat, verify results
- [ ] Update CLAUDE.md with setup instructions
- [ ] Update `.env.example` if any new vars needed (probably none)

**Tech stack:**
- Node.js TypeScript (same as provisioning script)
- `node-fetch` or similar for HTTP calls (reuse existing)
- Python tool definitions as strings (hardcoded or loaded from file)

**Deliverables:**
- Provisioning script that creates tools
- Test coverage (provisioning works, tools callable)
- CLAUDE.md updated
- Brief implementation notes

---

## 9. Known Limitations & Deferred

**NOT in D1:**
- ✗ MADE governance on tool calls (skip per recommendation)
- ✗ Auto-tool-recommendation (model suggests tool) — out of scope
- ✗ Tool result formatting/UI customization
- ✗ Sheets/slides porting (future D2+)
- ✗ GenOffice docs launcher (trivial, D2)

---

**Spec ready for coder implementation. Next: Plan writing for D1.**
