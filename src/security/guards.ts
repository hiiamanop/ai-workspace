import net from "node:net";
import { timingSafeEqual } from "node:crypto";

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Rejects URLs that could reach infrastructure or local metadata services. */
export function assertPublicHttpUrl(value: string, label = "url"): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is not a valid URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported scheme ${url.protocol}`);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname.includes(":")) throw new Error("IPv6 literal hosts are not allowed");
  if (!hostname || hostname === "localhost" || hostname === "searxng" || hostname === "scrapling" || hostname === "made" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" || hostname === "metadata" || hostname === "instance-data" ||
    hostname === "host.docker.internal" || net.isIP(hostname) > 0 && isPrivateIp(hostname)) {
    throw new Error(`${label} targets an internal/private host`);
  }
  // DNS names resolving to private addresses require a DNS-pinning-aware
  // resolver at the network boundary; reject obvious numeric forms here.
  if (hostname === "0" || hostname === "0.0.0.0" || hostname.includes("..")) throw new Error(`${label} targets an internal/private host`);
  return url;
}

function isPrivateIp(host: string): boolean {
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const normalized = host.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

export function assertPayloadSize(bytes: number, maxBytes = DEFAULT_MAX_BODY_BYTES): void {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > maxBytes) throw new Error(`request payload exceeds ${maxBytes} bytes`);
}

export interface RateLimitResult { allowed: boolean; remaining: number; resetAt: number; }

/** Fixed-window limiter. Use a shared store in production for multi-instance deployments. */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now = () => Date.now()) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) throw new Error("invalid rate limit configuration");
  }
  consume(key: string): RateLimitResult {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) { window = { count: 0, resetAt: now + this.windowMs }; this.windows.set(key, window); }
    if (window.count >= this.limit) return { allowed: false, remaining: 0, resetAt: window.resetAt };
    window.count++;
    return { allowed: true, remaining: this.limit - window.count, resetAt: window.resetAt };
  }
  clear(key?: string): void { if (key) this.windows.delete(key); else this.windows.clear(); }
}

export interface ServiceAuth { service: string; token: string; }
export function assertServiceAuth(received: string | undefined, expected: ServiceAuth): void {
  if (!received || received.length !== expected.token.length) throw new Error(`unauthorized internal service: ${expected.service}`);
  const actual = Buffer.from(received);
  const wanted = Buffer.from(expected.token);
  if (!timingSafeEqual(actual, wanted)) throw new Error(`unauthorized internal service: ${expected.service}`);
}
