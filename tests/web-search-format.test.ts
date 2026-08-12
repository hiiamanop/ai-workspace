import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWebSearchResults } from "../src/web-search-format.ts";

test("formatWebSearchResults() numbers results starting at offset + 1", () => {
  const text = formatWebSearchResults(
    {
      results: [
        { title: "First", url: "https://a.example", snippet: "snippet a" },
        { title: "Second", url: "https://b.example", snippet: "snippet b", publishedDate: "2024-01-01" },
      ],
    },
    0
  );

  assert.equal(
    text,
    "[1] First\n    snippet a\n    https://a.example\n\n[2] Second — 2024-01-01\n    snippet b\n    https://b.example"
  );
});

test("formatWebSearchResults() continues numbering from a non-zero offset", () => {
  const text = formatWebSearchResults(
    { results: [{ title: "Third", url: "https://c.example", snippet: "snippet c" }] },
    2
  );

  assert.match(text, /^\[3\] Third/);
});

test("formatWebSearchResults() prepends the direct answer when present", () => {
  const text = formatWebSearchResults(
    { results: [{ title: "Only", url: "https://a.example", snippet: "s" }], answer: "42" },
    0
  );

  assert.ok(text.startsWith("Direct answer: 42\n\n[1] Only"));
});

test("formatWebSearchResults() returns a placeholder when there are no results", () => {
  const text = formatWebSearchResults({ results: [] }, 0);

  assert.equal(text, "(no results)");
});
