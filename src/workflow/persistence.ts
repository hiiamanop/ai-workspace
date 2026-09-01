import { DatabaseSync } from "node:sqlite";
import type { WorkflowLimits, StepUsage } from "./runner.js";
import type { WorkflowRunEnvelope, WorkflowStatus } from "./envelope.js";

export interface PersistedWorkflow { run: WorkflowRunEnvelope; limits: WorkflowLimits; usage: StepUsage; startedAt?: number; }

export class WorkflowPersistence {
  private readonly db: DatabaseSync;
  constructor(path = process.env.WORKFLOW_DB_PATH ?? "./workflow.db") {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT,
      intent TEXT NOT NULL, data_classification TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, envelope_json TEXT NOT NULL, limits_json TEXT NOT NULL,
      usage_json TEXT NOT NULL, started_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_actor ON workflow_runs(actor_id);`);
  }
  save(record: PersistedWorkflow): void {
    const r = record.run;
    this.db.prepare(`INSERT INTO workflow_runs
      (run_id, workflow_id, status, actor_id, intent, data_classification, created_at, updated_at,
       envelope_json, limits_json, usage_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET workflow_id=excluded.workflow_id,status=excluded.status,
       actor_id=excluded.actor_id,intent=excluded.intent,data_classification=excluded.data_classification,
       created_at=excluded.created_at,updated_at=excluded.updated_at,envelope_json=excluded.envelope_json,
       limits_json=excluded.limits_json,usage_json=excluded.usage_json,started_at=excluded.started_at`).run(
      r.run_id, r.workflow_id, r.status, r.actor_id ?? null, r.intent, r.data_classification,
      r.created_at, r.updated_at, JSON.stringify(r), JSON.stringify(record.limits), JSON.stringify(record.usage), record.startedAt ?? null);
  }
  get(runId: string): PersistedWorkflow | undefined { const row = this.db.prepare("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined; return row ? this.decode(row) : undefined; }
  list(status?: WorkflowStatus): PersistedWorkflow[] { const rows = (status ? this.db.prepare("SELECT * FROM workflow_runs WHERE status = ? ORDER BY created_at").all(status) : this.db.prepare("SELECT * FROM workflow_runs ORDER BY created_at").all()) as Record<string, unknown>[]; return rows.map((r) => this.decode(r)); }
  recoverInterrupted(): PersistedWorkflow[] { this.db.prepare("UPDATE workflow_runs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(new Date().toISOString()); return this.list(); }
  close(): void { this.db.close(); }
  private decode(row: Record<string, unknown>): PersistedWorkflow {
    const envelope = JSON.parse(String(row.envelope_json)) as WorkflowRunEnvelope;
    // Indexed state is authoritative after recovery transitions.
    envelope.status = String(row.status) as WorkflowStatus;
    envelope.updated_at = String(row.updated_at);
    return { run: envelope, limits: JSON.parse(String(row.limits_json)) as WorkflowLimits, usage: JSON.parse(String(row.usage_json)) as StepUsage, startedAt: row.started_at == null ? undefined : Number(row.started_at) };
  }
}
