# Plan: D1 — Open WebUI Tools Registry (Web Search + Scrape)

**Date:** 2026-08-13  
**Spec:** `docs/superpowers/specs/2026-08-13-openwebui-tools-registry-design.md`  
**Complexity:** Low (provisioning script, no backend changes)  
**Phases:** 1 (all implementation)

---

## Overview

Implement provisioning script to register `web_search` and `scrape` as native Open WebUI Tools. Tools call existing backend endpoints (`/api/web-search`, `/api/scrape`). No backend changes needed.

---

## Step-by-Step Implementation

### Phase 1: Provisioning Script

**Step 1: Create provisioning script**
- File: `src/openwebui-provision-tools.ts`
- Structure (similar to `openwebui-provision.ts`):
  1. Load tool definitions (hardcoded or from JSON)
  2. Sign into Open WebUI (fetch admin token)
  3. For each tool:
     - Check if tool exists: GET `/api/v1/tools/{id}`
     - If exists: PUT `/api/v1/tools/{id}` (update)
     - If not: POST `/api/v1/tools/create` (create)
  4. Verify tools appear in listing: GET `/api/v1/tools`
  5. Return success

**Step 2: Define web_search tool**
- Tool ID: `web_search`
- Name: "Web Search"
- Description: "Search the web using SearXNG"
- Python source (spec section 4.1):
  - Accept `query: str, language: str = "en"`
  - Call `POST http://localhost:3000/api/web-search` with params
  - Return structured result: `{ status, results, count }`
  - Error handling: catch exceptions, return error object

**Step 3: Define scrape tool**
- Tool ID: `scrape`
- Name: "Web Scrape"
- Description: "Scrape content from a URL"
- Python source (spec section 4.1):
  - Accept `url: str`
  - Call `POST http://localhost:3000/api/scrape` with params
  - Return structured result: `{ status, content, url }`
  - Error handling: catch exceptions, return error object

**Step 4: Implement idempotent create/update**
- GET tool first (check if exists)
- If exists with same source: skip (already up-to-date)
- If exists with different source: PUT to update
- If not exists: POST to create
- Log each action: "Creating web_search", "Updating scrape", "web_search already up-to-date"

**Step 5: Add CLI entry point**
- Similar to `openwebui-provision.ts` — runnable via `node --import tsx`
- Args: none (hardcoded endpoint URLs, use env vars for OPENWEBUI_URL if needed)
- Output: success message or error details

**Step 6: Wire into docker-compose setup (optional)**
- Add comment in CLAUDE.md: "Re-run provisioning script after pulling new changes"
- Script idempotent, safe to run multiple times

---

### Phase 2: Testing

**Step 7: Unit tests**
- File: `tests/openwebui-provision-tools.test.ts`
- Test: tool definitions are valid Python (syntax check)
- Test: tool function signatures match spec (accepts correct params, returns correct shape)
- Test: error handling (mock backend 5xx, tool returns error object)
- Test: idempotent provisioning (run twice, second time skips)

**Step 8: Integration tests**
- File: `tests/openwebui-integration.test.ts` (if not exists)
- Setup: start Open WebUI (via docker-compose or mock)
- Test: provision tools via script
- Test: tools appear in GET `/api/v1/tools` listing
- Test: tool metadata correct (name, description)
- Test: tool callable (mock chat invocation)
- Teardown: cleanup

**Step 9: Manual testing**
- Start `docker compose up`
- Run provisioning: `node --import tsx src/openwebui-provision-tools.ts`
- Verify success: check logs for "web_search created", "scrape created"
- Open Open WebUI (http://localhost:3001)
- Check Admin Settings → Workspace → Tools
  - Should list "Web Search" and "Web Scrape"
  - Both should be enabled/active
- Test in chat:
  - Ask model: "search for 'what is the capital of france' on the web"
  - Should trigger web_search tool
  - Should get results back
  - Test scrape similarly

---

### Phase 3: Documentation

**Step 10: Update CLAUDE.md**
- Add section: "Tools Registration (D1, Admin-only)" (see spec section 7)
- Instructions:
  1. Ensure Open WebUI running
  2. Run provisioning script: `node --import tsx src/openwebui-provision-tools.ts`
  3. Verify in Admin Settings → Workspace → Tools
  4. Re-run script after pulling changes

**Step 11: Update .env.example (if needed)**
- Add `OPENWEBUI_URL` if not already there (used by provisioning script)
- Default: `http://localhost:3001`

---

## Files Created / Modified

```
src/
├── openwebui-provision-tools.ts      [NEW: provisioning script]

tests/
└── openwebui-provision-tools.test.ts [NEW: unit tests]

CLAUDE.md                              [MODIFY: add D1 setup section]
.env.example                           [MODIFY: add OPENWEBUI_URL if missing]
```

---

## Testing Checklist

- [ ] Unit tests: tool definitions valid Python
- [ ] Unit tests: error handling works
- [ ] Unit tests: idempotent (run twice, second skips)
- [ ] Integration test: tools appear after provisioning
- [ ] Integration test: tool metadata correct
- [ ] Integration test: tool callable (mock invoke)
- [ ] Manual test: provisioning script runs cleanly
- [ ] Manual test: tools appear in Open WebUI UI
- [ ] Manual test: invoke web_search from chat
- [ ] Manual test: invoke scrape from chat
- [ ] npm test passes (all suites)
- [ ] npx tsc --noEmit clean

---

## Deliverables

**After coder completes D1:**
1. Provisioning script (create/update idempotent)
2. Web_search + scrape tool definitions (Python functions)
3. Full test coverage (unit + integration + manual)
4. CLAUDE.md updated with setup instructions
5. Brief implementation notes if deviations from spec

---

## Model Selection

- **Implementation:** Haiku (straightforward provisioning script)
- **Testing:** Haiku (unit + integration tests)
- **Review:** Sonnet (tooling integration correctness)

---

**Ready for coder implementation. Plan complete.**
