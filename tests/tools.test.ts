import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFS } from "../src/tools.ts";

test("TOOL_DEFS has an entry for web_search and scrape with matching function names", () => {
  assert.equal(TOOL_DEFS.web_search.function.name, "web_search");
  assert.equal(TOOL_DEFS.scrape.function.name, "scrape");
});

test("TOOL_DEFS entries declare their required parameters", () => {
  assert.deepEqual(TOOL_DEFS.web_search.function.parameters.required, ["query"]);
  assert.deepEqual(TOOL_DEFS.scrape.function.parameters.required, ["url"]);
});
