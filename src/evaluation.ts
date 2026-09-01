export interface EvaluationCase<I = unknown, O = unknown> { id: string; input: I; expected: O; run: (input: I) => Promise<O> | O; equal?: (actual: O, expected: O) => boolean; }
export interface EvaluationReport { total: number; passed: number; failed: number; cases: Array<{ id: string; passed: boolean; error?: string }>; }

export interface FailureScenario { id: string; run: () => Promise<unknown> | unknown; expectedError?: RegExp; }

/** Exercise model/policy/transport/connector failure paths without network calls. */
export async function evaluateFailureScenarios(scenarios: FailureScenario[]): Promise<EvaluationReport> {
  return evaluateCases(scenarios.map((scenario) => ({
    id: scenario.id,
    input: undefined,
    expected: true,
    run: async () => {
      try { await scenario.run(); return false; }
      catch (error) { return !scenario.expectedError || scenario.expectedError.test(error instanceof Error ? error.message : String(error)); }
    },
  })));
}

/** Deterministic, dependency-free evaluator for workflow/MCP contract fixtures. */
export async function evaluateCases<I, O>(cases: Array<EvaluationCase<I, O>>): Promise<EvaluationReport> {
  const results = [] as EvaluationReport["cases"];
  for (const item of cases) {
    try {
      const actual = await item.run(item.input);
      const passed = item.equal ? item.equal(actual, item.expected) : JSON.stringify(actual) === JSON.stringify(item.expected);
      results.push({ id: item.id, passed, ...(passed ? {} : { error: "actual result differs from expected" }) });
    } catch (error) { results.push({ id: item.id, passed: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { total: results.length, passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, cases: results };
}

export function failureInjector<T extends (...args: any[]) => any>(fn: T, shouldFail: (call: number) => boolean, message = "injected failure"): T {
  let calls = 0;
  return (async (...args: Parameters<T>) => { calls++; if (shouldFail(calls)) throw new Error(message); return await fn(...args); }) as T;
}
