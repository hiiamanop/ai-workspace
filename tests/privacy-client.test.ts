import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, redact } from "../src/privacy-client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("classify() caches per (orgId, text) and does not refetch", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse({ classification: "confidential" });
  }) as unknown as typeof fetch;

  const a = await classify("org-cache-1", "same text", "http://made", fetchImpl);
  const b = await classify("org-cache-1", "same text", "http://made", fetchImpl);

  assert.equal(a, "confidential");
  assert.equal(b, "confidential");
  assert.equal(calls, 1);
});

test("redact() throws on a non-200 so the caller can degrade", async () => {
  const fetchImpl = (async () => jsonResponse({ detail: "boom" }, 500)) as unknown as typeof fetch;

  await assert.rejects(
    () => redact("org-err-1", "unique text here", "http://made", fetchImpl),
    /returned 500/
  );
});
