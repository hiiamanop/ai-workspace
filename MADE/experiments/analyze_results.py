"""Aggregate policy_violation_rate/cost/quality/latency per baseline from an
experiment results CSV (produced by core.experiment.metrics.export_results_csv).

Run:
  python experiments/analyze_results.py experiments/results/v1.csv
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path


def load_results(csv_path: Path) -> dict[str, list[dict]]:
    by_baseline: dict[str, list[dict]] = defaultdict(list)
    with csv_path.open() as f:
        for row in csv.DictReader(f):
            by_baseline[row["baseline"]].append(row)
    return dict(by_baseline)


def summarize(rows: list[dict]) -> dict:
    ok_rows = [r for r in rows if r["status"] == "ok"]
    n_failed = sum(1 for r in rows if r["status"] == "failed")
    n_no_selection = sum(1 for r in rows if r["status"] == "no_selection")
    n = len(ok_rows)
    if n == 0:
        return {"n": 0, "n_failed": n_failed, "n_no_selection": n_no_selection,
                "policy_violation_rate": None, "mean_cost_usd": None,
                "mean_quality": None, "mean_latency_ms": None}

    violations = sum(1 for r in ok_rows if r["policy_violation"] in ("True", "true", "1"))
    return {
        "n": n,
        "n_failed": n_failed,
        "n_no_selection": n_no_selection,
        "policy_violation_rate": violations / n,
        "mean_cost_usd": sum(float(r["cost_usd"]) for r in ok_rows) / n,
        "mean_quality": sum(float(r["quality_score"]) for r in ok_rows) / n,
        "mean_latency_ms": sum(float(r["latency_ms"]) for r in ok_rows) / n,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python experiments/analyze_results.py <results.csv>")
        return 1

    csv_path = Path(sys.argv[1])
    by_baseline = load_results(csv_path)

    header = f"{'baseline':<15} {'n':>5} {'violation_rate':>15} {'mean_cost':>12} {'mean_quality':>13} {'mean_latency_ms':>16}"
    print(header)
    for baseline, rows in sorted(by_baseline.items()):
        s = summarize(rows)
        if s["n"] == 0:
            print(f"{baseline:<15} {s['n']:>5} {'n/a':>15} {'n/a':>12} {'n/a':>13} {'n/a':>16}")
            continue
        print(f"{baseline:<15} {s['n']:>5} {s['policy_violation_rate']:>15.3f} "
              f"{s['mean_cost_usd']:>12.5f} {s['mean_quality']:>13.3f} {s['mean_latency_ms']:>16.1f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
