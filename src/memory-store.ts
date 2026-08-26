import { DatabaseSync } from "node:sqlite";

// Per-user fact list for the "memory" Tool — not a proxy to Open WebUI's own
// memories API (that's strictly per-user via an auth token Tools don't
// receive; see docs/PRD-openwebui-integrations.md). node:sqlite is Node's
// stdlib (Node 22+), no new dependency.

export interface MemoryEntry {
  id: number;
  userId: string;
  fact: string;
  createdAt: string;
}

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!db) {
    const path = process.env.MEMORY_DB_PATH ?? "./memory.db";
    db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }
  return db;
}

export function remember(userId: string, fact: string): MemoryEntry {
  const stmt = getDb().prepare("INSERT INTO memories (user_id, fact) VALUES (?, ?) RETURNING id, created_at");
  const row = stmt.get(userId, fact) as { id: number; created_at: string };
  return { id: row.id, userId, fact, createdAt: row.created_at };
}

export function recall(userId: string, query: string): MemoryEntry[] {
  const stmt = getDb().prepare(
    "SELECT id, fact, created_at FROM memories WHERE user_id = ? AND fact LIKE ? ORDER BY created_at DESC"
  );
  const rows = stmt.all(userId, `%${query}%`) as { id: number; fact: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, userId, fact: r.fact, createdAt: r.created_at }));
}

export function _resetForTests(): void {
  db?.close();
  db = null;
}
