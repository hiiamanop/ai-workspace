# Design: Milestone 2 Hardening — Round 2

Status: approved by user (2026-08-09).
Follow-up to `docs/superpowers/specs/2026-08-09-milestone-2-hardening-design.md`. Addresses 3 items deferred at that pass's final review, now promoted because the user plans to host this app on a cloud VM (raising the SSRF item from Minor to must-fix) and has created a real `.env` file they want `docker-compose.yaml` to actually use.

## 1. Extend SSRF hardening on `scrape` for cloud deployment

`src/mcp/scrapling-client.ts`'s `assertUrlAllowed` currently blocks known internal hostnames and IPv4 addresses in `127.*`/`10.*`/`172.16-31.*`/`192.168.*`. Investigation (via `new URL(...)` behavior, confirmed interactively) established:

- **IPv4 numeric-encoding tricks (decimal, hex, octal, short forms) are already neutralized** — Node's WHATWG `URL` parser normalizes `http://2130706433/`, `http://0x7f.0.0.1/`, `http://0177.0.0.1/`, and `http://127.1/` all to `hostname: "127.0.0.1"` *before* our code ever inspects it. No new code is needed for this; a regression test is added to prove it and guard against a future Node/URL-spec behavior change.
- **169.254.0.0/16 (link-local, includes the cloud metadata address `169.254.169.254`) is NOT currently blocked.** This is the priority fix — cloud metadata endpoints on AWS/GCP/Azure expose instance credentials/IAM tokens with no auth, reachable at `169.254.169.254` from inside the VM. Add: any hostname matching `169.254.*` is rejected.
- **`0.0.0.0` (and the `0.0.0.0/8` "this network" block) is NOT currently blocked.** Add: any hostname where the first octet is `0` is rejected.
- **IPv6 literals are NOT currently blocked at all** (`[::1]`, `[::ffff:127.0.0.1]`, etc. all pass through unexamined — confirmed `new URL("http://[::1]/").hostname === "[::1]"`, brackets included). Rather than parsing every IPv6 private/loopback range (unique-local `fc00::/7`, link-local `fe80::/10`, loopback `::1`, IPv4-mapped `::ffff:0:0/96`), block **all** bracketed IPv6-literal hosts outright. Legitimate scrape targets are domain names, not raw IPv6 addresses; this closes the entire bypass class with one simple, defensible rule. `// ponytail: blocks all IPv6 literals rather than parsing private ranges — revisit with proper IPv6 range checks only if a real need to scrape an IPv6-literal URL shows up.`

## 2. `docker-compose.yaml` reads from `.env` instead of hardcoding values

The `app` service's `environment:` block currently hardcodes `MADE_URL`, `SEARXNG_URL`, `SCRAPLING_URL`, `OLLAMA_BASE_URL` directly in `docker-compose.yaml`, with only `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` sourced from `.env` via `${VAR}` substitution. The user has created a real `.env` (from `.env.example`'s docker-oriented values) and wants the compose file to actually read from it rather than duplicate the values inline.

Replace the `environment:` block with `env_file: .env`. Docker Compose loads every variable in `.env` directly into the container's environment. This requires no change to `.env.example`'s content (its active/uncommented block already has the correct docker-oriented values: `MADE_URL=http://made:8000`, `SEARXNG_URL=http://searxng:8080`, `SCRAPLING_URL=http://scrapling:8000/mcp`, `OLLAMA_BASE_URL=http://host.docker.internal:11434`, plus `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`) — as a side effect, this also resolves the previously-deferred finding that the docker block in `.env.example` was "inert" for `docker compose up`: it becomes genuinely wired in.

`extra_hosts` (the `host.docker.internal:host-gateway` mapping) and `depends_on` are unrelated to environment variables and stay unchanged. `.env` is already listed in `.gitignore` (added in Milestone 1), so no secret-handling change is needed.

## 3. Two small fixes

**3a. Surrogate-pair-safe truncation** (`src/chat.ts`)
`truncateToolResult`'s `result.slice(0, MAX_TOOL_RESULT_CHARS)` can land in the middle of a UTF-16 surrogate pair (e.g. a 4-byte emoji), leaving a dangling unpaired high surrogate at the end of the truncated string. Fix: after computing the cut point, check `result.charCodeAt(cut - 1)`; if it falls in the high-surrogate range (`0xD800`–`0xDBFF`), back off one character before appending the truncation marker.

**3b. `toolsUsed` shown as counted summary, not a raw repeated list** (`public/index.html`)
Repeated tool names in `toolsUsed` (e.g. two `web_search` calls with different queries) are real, independent invocations with potentially different results — deduplicating them would hide real information. But rendering them as a flat repeated list (`web_search, web_search`) reads as a display glitch rather than intentional signal. Fix: group `toolsUsed` by name client-side and render as `name ×count` (e.g. `[tools: web_search ×2, scrape ×1]`); a tool called once renders as just its name with no `×1` suffix, to keep the common case clean.

## 4. Testing

- Item 1: tests proving the already-normalized encoding tricks are blocked (regression guard, not new logic); tests for `169.254.169.254` and other `169.254.*` addresses rejected; test for `0.0.0.0` and `0.x.x.x` rejected; tests for `[::1]` and `[::ffff:127.0.0.1]` (or any bracketed IPv6 host) rejected. All via the existing fake-`connect` DI pattern, asserting `connect` was never called.
- Item 2: no automated test (compose config change) — verified manually via `docker compose config` showing the resolved environment, and a live `docker compose up` chat request, matching the manual-verification style of prior milestone work.
- Item 3a: unit test with a string engineered so the 8000-char cut point lands exactly inside a surrogate pair (e.g. `"x".repeat(7999) + "😀" + "x".repeat(1000)`), asserting the truncated output contains no lone surrogate and is valid UTF-16 (round-trips through `Buffer.from(str, "utf16le")`/`TextEncoder` without producing replacement characters, or more simply: asserting `cut` backed off by one and the marker's reported original length is still correct).
- Item 3b: unit-style test isn't applicable to inline `<script>` in a static HTML file (same as the original Milestone 2 hardening's item 3) — verified manually in the browser as part of this round's own end-to-end check, same practice as before.

## 5. Out of Scope

- Full generic IPv6 private-range parsing — deliberately replaced with "block all IPv6 literals" per item 1.
- DNS-rebinding protection (a hostname that resolves to a private IP only at request time, or redirects there) — Scrapling itself makes the real HTTP request in its own container; our validation is a pre-flight string check on the URL as given, not a runtime network-level guard. Out of scope for this pass; would require either a network-level egress policy on the `scrapling` container or Scrapling-side SSRF protection, neither of which this project controls.
- Any change to Milestone 3/4 scope.
