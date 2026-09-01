import { addWorkflowStep, type WorkflowRunEnvelope, type WorkflowStep } from "./envelope.js";
import { WorkflowPersistence, type PersistedWorkflow } from "./persistence.js";

export interface WorkflowLimits {
  maxSteps: number;
  timeoutMs: number;
  maxRetries: number;
  tokenBudget: number;
  costBudgetUsd: number;
}

export interface StepUsage { tokens?: number; costUsd?: number }
export interface StepExecutionResult<T = unknown> { output: T; usage?: StepUsage }
export type StepExecutor<T = unknown> = (step: WorkflowStep, signal: AbortSignal) => Promise<StepExecutionResult<T>>;

export class WorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = "WorkflowError";
  }
}

const TERMINAL = new Set(["completed", "failed"] as const);

/** In-memory bounded runner. Persistence can wrap this contract without changing transitions. */
export class WorkflowRunner {
  private readonly runs = new Map<string, WorkflowRunEnvelope>();
  private readonly limitsByRun = new Map<string, WorkflowLimits>();
  private readonly startedAt = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private readonly usage = new Map<string, StepUsage>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly defaults: Partial<WorkflowLimits> = {}, private readonly persistence?: WorkflowPersistence) {}

  restorePersisted(): WorkflowRunEnvelope[] {
    if (!this.persistence) return [];
    const records = this.persistence.recoverInterrupted();
    for (const record of records) this.restore(record);
    return records.map((record) => this.snapshot(record.run.run_id));
  }

  register(run: WorkflowRunEnvelope, limits: Partial<WorkflowLimits> = {}): WorkflowRunEnvelope {
    if (this.runs.has(run.run_id)) return this.snapshot(run.run_id);
    const resolved = this.resolveLimits(limits);
    if (resolved.maxSteps < 1 || resolved.timeoutMs < 1 || resolved.maxRetries < 0 || resolved.tokenBudget < 0 || resolved.costBudgetUsd < 0) {
      throw new WorkflowError("INVALID_LIMITS", "workflow limits must be non-negative and maxSteps/timeoutMs must be positive");
    }
    if (run.steps.length > resolved.maxSteps) throw new WorkflowError("MAX_STEPS_EXCEEDED", "run already exceeds maximum steps");
    this.runs.set(run.run_id, structuredClone(run));
    this.limitsByRun.set(run.run_id, resolved);
    this.persist(run.run_id);
    return this.snapshot(run.run_id);
  }

  get(runId: string): WorkflowRunEnvelope {
    if (!this.runs.has(runId)) throw new WorkflowError("RUN_NOT_FOUND", `workflow run ${runId} was not found`);
    return this.snapshot(runId);
  }

  addStep(runId: string, input: Omit<WorkflowStep, "id" | "status">): WorkflowRunEnvelope {
    const run = this.mutable(runId);
    const limits = this.limitsByRun.get(runId)!;
    if (TERMINAL.has(run.status as "completed" | "failed") || run.status === "cancelled") throw new WorkflowError("RUN_TERMINAL", `cannot add a step to ${run.status}`);
    if (run.steps.length >= limits.maxSteps) throw new WorkflowError("MAX_STEPS_EXCEEDED", `maximum of ${limits.maxSteps} steps exceeded`);
    const updated = addWorkflowStep(run, input);
    this.runs.set(runId, updated);
    this.persist(runId);
    return this.snapshot(runId);
  }

  start(runId: string): WorkflowRunEnvelope {
    const run = this.mutable(runId);
    if (run.status === "running") return this.snapshot(runId);
    if (run.status !== "queued") throw new WorkflowError("INVALID_TRANSITION", `cannot start a ${run.status} run`);
    this.startedAt.set(runId, Date.now());
    this.runs.set(runId, { ...run, status: "running", updated_at: new Date().toISOString(), error: undefined });
    this.persist(runId);
    return this.snapshot(runId);
  }

  cancel(runId: string, reason = "cancelled by actor"): WorkflowRunEnvelope {
    const run = this.mutable(runId);
    if (run.status === "cancelled") return this.snapshot(runId);
    if (TERMINAL.has(run.status as "completed" | "failed")) throw new WorkflowError("INVALID_TRANSITION", `cannot cancel a ${run.status} run`);
    this.controllers.get(runId)?.abort(reason);
    this.runs.set(runId, { ...run, status: "cancelled", updated_at: new Date().toISOString(), error: { code: "CANCELLED", message: reason } });
    this.persist(runId);
    return this.snapshot(runId);
  }

  /** Resume is idempotent: cancelled runs return to queued and can be started again. */
  resume(runId: string): WorkflowRunEnvelope {
    const run = this.mutable(runId);
    if (run.status === "queued" || run.status === "running") return this.snapshot(runId);
    if (run.status !== "cancelled" && run.status !== "waiting_approval") throw new WorkflowError("INVALID_TRANSITION", `cannot resume a ${run.status} run`);
    this.runs.set(runId, { ...run, status: "queued", updated_at: new Date().toISOString(), error: undefined });
    this.persist(runId);
    return this.snapshot(runId);
  }

  complete(runId: string, verification?: { status: "passed" | "failed"; message?: string }): WorkflowRunEnvelope {
    const run = this.mutable(runId);
    if (run.status === "completed") return this.snapshot(runId);
    if (run.status !== "running") throw new WorkflowError("INVALID_TRANSITION", `cannot complete a ${run.status} run`);
    if (verification?.status === "failed") return this.fail(runId, "VERIFICATION_FAILED", verification.message ?? "final verification failed");
    this.runs.set(runId, { ...run, status: "completed", updated_at: new Date().toISOString(), verification: verification ? { ...verification, verified_at: new Date().toISOString() } : undefined });
    this.persist(runId);
    return this.snapshot(runId);
  }

  fail(runId: string, code: string, message: string, stepId?: string): WorkflowRunEnvelope {
    const run = this.mutable(runId);
    if (run.status === "failed") return this.snapshot(runId);
    if (run.status === "completed" || run.status === "cancelled") throw new WorkflowError("INVALID_TRANSITION", `cannot fail a ${run.status} run`);
    this.runs.set(runId, { ...run, status: "failed", updated_at: new Date().toISOString(), error: { code, message, step_id: stepId } });
    this.persist(runId);
    return this.snapshot(runId);
  }

  async executeStep<T>(runId: string, stepId: string, executor: StepExecutor<T>): Promise<StepExecutionResult<T>> {
    const run = this.mutable(runId);
    if (run.status !== "running") throw new WorkflowError("INVALID_TRANSITION", `cannot execute a step while run is ${run.status}`);
    const step = run.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new WorkflowError("STEP_NOT_FOUND", `workflow step ${stepId} was not found`);
    if (step.status === "completed") throw new WorkflowError("STEP_ALREADY_COMPLETED", `workflow step ${stepId} is already completed`);
    const limits = this.limitsByRun.get(runId)!;
    if (Date.now() - (this.startedAt.get(runId) ?? Date.now()) >= limits.timeoutMs) { this.fail(runId, "WORKFLOW_TIMEOUT", "workflow timeout exceeded", stepId); throw new WorkflowError("WORKFLOW_TIMEOUT", "workflow timeout exceeded"); }
    const key = `${runId}:${stepId}`;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    this.controllers.get(runId)?.abort();
    const controller = new AbortController(); this.controllers.set(runId, controller);
    this.updateStep(runId, stepId, { status: "running", error: undefined });
    try {
      const result = await this.withTimeout(executor(step, controller.signal), limits.timeoutMs - (Date.now() - (this.startedAt.get(runId) ?? Date.now())), controller.signal);
      const total = this.usage.get(runId) ?? {};
      const next = { tokens: (total.tokens ?? 0) + (result.usage?.tokens ?? 0), costUsd: (total.costUsd ?? 0) + (result.usage?.costUsd ?? 0) };
      if (next.tokens > limits.tokenBudget) throw new WorkflowError("TOKEN_BUDGET_EXCEEDED", "workflow token budget exceeded");
      if (next.costUsd > limits.costBudgetUsd) throw new WorkflowError("COST_BUDGET_EXCEEDED", "workflow cost budget exceeded");
      this.usage.set(runId, next); this.updateStep(runId, stepId, { status: "completed" }); this.persist(runId);
      return result;
    } catch (error) {
      if (this.get(runId).status === "cancelled") throw error;
      const failure = error instanceof WorkflowError ? error : new WorkflowError("STEP_FAILED", error instanceof Error ? error.message : String(error), true);
      this.updateStep(runId, stepId, { status: "failed", error: { code: failure.code, message: failure.message } });
      if (failure.code === "TOKEN_BUDGET_EXCEEDED" || failure.code === "COST_BUDGET_EXCEEDED" || failure.code === "WORKFLOW_TIMEOUT" || attempt > limits.maxRetries) this.fail(runId, failure.code, failure.message, stepId);
      else this.updateStep(runId, stepId, { status: "pending", error: { code: failure.code, message: failure.message } });
      throw failure;
    } finally { if (this.controllers.get(runId) === controller) this.controllers.delete(runId); }
  }

  private resolveLimits(input: Partial<WorkflowLimits>): WorkflowLimits { return { maxSteps: input.maxSteps ?? this.defaults.maxSteps ?? 20, timeoutMs: input.timeoutMs ?? this.defaults.timeoutMs ?? 120_000, maxRetries: input.maxRetries ?? this.defaults.maxRetries ?? 2, tokenBudget: input.tokenBudget ?? this.defaults.tokenBudget ?? 100_000, costBudgetUsd: input.costBudgetUsd ?? this.defaults.costBudgetUsd ?? 10 }; }
  private mutable(runId: string): WorkflowRunEnvelope { return this.get(runId); }
  private snapshot(runId: string): WorkflowRunEnvelope { return structuredClone(this.runs.get(runId)!); }
  private updateStep(runId: string, stepId: string, patch: Partial<WorkflowStep>): void { const run = this.mutable(runId); const steps = run.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step); this.runs.set(runId, { ...run, steps, updated_at: new Date().toISOString() }); this.persist(runId); }
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> { if (signal.aborted) throw new WorkflowError("CANCELLED", "step cancelled"); const timeout = Math.max(1, timeoutMs); return await new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(new WorkflowError("WORKFLOW_TIMEOUT", "workflow timeout exceeded")), timeout); const onAbort = () => { clearTimeout(timer); reject(new WorkflowError("CANCELLED", "step cancelled")); }; signal.addEventListener("abort", onAbort, { once: true }); promise.then((value) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(error); }); }); }

  private restore(record: PersistedWorkflow): void { if (this.runs.has(record.run.run_id)) return; this.runs.set(record.run.run_id, structuredClone(record.run)); this.limitsByRun.set(record.run.run_id, record.limits); this.usage.set(record.run.run_id, record.usage); if (record.startedAt) this.startedAt.set(record.run.run_id, record.startedAt); }
  private persist(runId: string): void { if (!this.persistence) return; this.persistence.save({ run: this.runs.get(runId)!, limits: this.limitsByRun.get(runId)!, usage: this.usage.get(runId) ?? {}, startedAt: this.startedAt.get(runId) }); }
}
