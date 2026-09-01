import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPayloadSize, assertPublicHttpUrl, FixedWindowRateLimiter, assertServiceAuth } from "../src/security/guards.ts";

test("URL guard rejects private, metadata, and non-http targets", () => {
  for (const url of ["http://127.0.0.1/x", "http://10.0.0.1", "http://localhost", "http://169.254.169.254", "file:///tmp/a"]) {
    assert.throws(() => assertPublicHttpUrl(url));
  }
  assert.equal(assertPublicHttpUrl("https://example.com/product").hostname, "example.com");
});

test("payload guard enforces bounded request size", () => {
  assert.doesNotThrow(() => assertPayloadSize(10, 10));
  assert.throws(() => assertPayloadSize(11, 10), /exceeds/);
});

test("fixed window limiter applies per-key quota", () => {
  let now = 1000;
  const limiter = new FixedWindowRateLimiter(2, 100, () => now);
  assert.equal(limiter.consume("user:a").allowed, true);
  assert.equal(limiter.consume("user:a").allowed, true);
  assert.equal(limiter.consume("user:a").allowed, false);
  assert.equal(limiter.consume("user:b").allowed, true);
  now += 100;
  assert.equal(limiter.consume("user:a").allowed, true);
});

test("service auth is fail-closed", () => {
  const expected = { service: "app", token: "secret" };
  assert.doesNotThrow(() => assertServiceAuth("secret", expected));
  assert.throws(() => assertServiceAuth(undefined, expected), /unauthorized/);
  assert.throws(() => assertServiceAuth("wrong", expected), /unauthorized/);
});
