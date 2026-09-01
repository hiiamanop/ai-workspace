# Security and reliability boundary

## Internal service authentication

Every internal HTTP call must carry a service token (for example
`Authorization: Bearer $MADE_SERVICE_TOKEN`). The receiving service validates
the token before parsing or executing a request and fails closed when the
secret is absent or invalid. Tokens belong only in the deployment secret
manager/environment; they must never be included in prompts, tool valves,
audit payloads, or logs. `src/security/guards.ts` contains the shared
constant-time comparison and bounded rate-limit primitives.

The current public chat server remains intentionally compatible with the
existing local development setup. Production deployment must put it behind an
authenticated reverse proxy and configure service tokens before enabling
cross-service calls. Token rotation is overlap-based: provision the new token,
accept old and new for one bounded grace window, switch callers, then revoke
the old token and verify the audit/health signal.

## Secret-manager boundary

The orchestrator receives opaque, short-lived references or environment
injection from a secret manager. MCP adapters resolve credentials at their own
boundary. No generic endpoint may return a secret or pass it into an LLM
context. A future adapter should implement:

```ts
interface SecretReference { name: string; version?: string }
interface SecretManager { get(ref: SecretReference): Promise<string>; }
```

Rotation and revocation are control-plane operations, not workflow tool calls.

## Egress guards

Scrape targets accept only HTTP(S), reject loopback, RFC1918/link-local,
container, metadata, and reserved hosts, and bound response text before it can
enter model context. The same guard must be used by every future URL-fetching
connector. DNS rebinding protection belongs at the egress proxy: resolve and
validate the address, then connect using the validated address.

## Recovery and database runbook

The SQLite workflow store is durable only when `WORKFLOW_DB_PATH` points to a
persistent volume. On startup call `restorePersisted()`: interrupted `running`
runs return to `queued`; `waiting_approval` remains waiting; terminal runs are
unchanged. A worker must not replay a completed step without its idempotency
key.

Back up while the process is quiesced (or using SQLite's online backup API),
verify the backup by opening it read-only, and retain encrypted, access-
controlled copies. Restore by stopping the app, replacing the database file
with a verified backup, and restarting; record the backup timestamp and
checksum in the incident/change log. Schema changes must be additive and
versioned before destructive changes are introduced.
