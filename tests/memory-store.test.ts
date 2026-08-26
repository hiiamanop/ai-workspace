import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remember, recall, _resetForTests } from "../src/memory-store.ts";

function freshDb() {
  _resetForTests();
  const dir = mkdtempSync(join(tmpdir(), "memory-store-test-"));
  process.env.MEMORY_DB_PATH = join(dir, "test.db");
}

test("remember() stores a fact and returns it with an id and timestamp", () => {
  freshDb();

  const entry = remember("user-1", "likes Indonesian coffee");

  assert.equal(entry.userId, "user-1");
  assert.equal(entry.fact, "likes Indonesian coffee");
  assert.ok(entry.id > 0);
  assert.ok(entry.createdAt);
});

test("recall() finds facts matching a substring query for that user", () => {
  freshDb();
  remember("user-1", "likes Indonesian coffee");
  remember("user-1", "works at a bank");

  const results = recall("user-1", "coffee");

  assert.equal(results.length, 1);
  assert.equal(results[0].fact, "likes Indonesian coffee");
});

test("recall() with an empty query returns all facts for that user", () => {
  freshDb();
  remember("user-1", "fact one");
  remember("user-1", "fact two");

  const results = recall("user-1", "");

  assert.equal(results.length, 2);
});

test("recall() only returns facts scoped to the requesting user", () => {
  freshDb();
  remember("user-1", "user one's secret");
  remember("user-2", "user two's secret");

  const results = recall("user-1", "");

  assert.equal(results.length, 1);
  assert.equal(results[0].fact, "user one's secret");
});
