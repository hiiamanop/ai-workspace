export type AuditOutcome = "started" | "allowed" | "denied" | "completed" | "failed";

export interface AuditEvent {
  id: string;
  at: string;
  type: string;
  outcome: AuditOutcome;
  run_id?: string;
  actor_id?: string;
  connector_id?: string;
  capability?: string;
  model_id?: string;
  tool_name?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AuditSink {
  record(event: Omit<AuditEvent, "id" | "at">): AuditEvent;
  list(): AuditEvent[];
}

export function createAuditSink(): AuditSink {
  const events: AuditEvent[] = [];
  return {
    record: (event) => {
      const stored: AuditEvent = { ...event, id: crypto.randomUUID(), at: new Date().toISOString() };
      events.push(stored);
      return structuredClone(stored);
    },
    list: () => structuredClone(events),
  };
}

/** Process-local sink for the default runtime. A durable backend can subscribe
 * later without changing the orchestration contract. */
export const defaultAuditSink = createAuditSink();
