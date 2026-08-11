"""Paired fair-comparison analysis: restrict every baseline's quality/cost/
latency averages to the exact scenario_ids where MADE actually selected a
candidate, so baselines aren't compared over an easier subset than MADE.
Also reports what baselines did on the scenarios MADE abstained on.

Run:
  python experiments/analyze_fair_quality.py experiments/results/v1.csv
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
    n = len(rows)
    if n == 0:
        return {"n": 0, "policy_violation_rate": None, "mean_cost_usd": None,
                "mean_quality": None, "mean_latency_ms": None}
    violations = sum(1 for r in rows if r["policy_violation"] in ("True", "true", "1"))
    return {
        "n": n,
        "policy_violation_rate": violations / n,
        "mean_cost_usd": sum(float(r["cost_usd"]) for r in rows) / n,
        "mean_quality": sum(float(r["quality_score"]) for r in rows) / n,
        "mean_latency_ms": sum(float(r["latency_ms"]) for r in rows) / n,
    }


def print_table(title: str, by_baseline: dict[str, list[dict]]) -> None:
    print(f"\n{title}")
    header = f"{'baseline':<15} {'n':>5} {'violation_rate':>15} {'mean_cost':>12} {'mean_quality':>13} {'mean_latency_ms':>16}"
    print(header)
    for baseline, rows in sorted(by_baseline.items()):
        s = summarize(rows)
        if s["n"] == 0:
            print(f"{baseline:<15} {'0':>5} {'n/a':>15} {'n/a':>12} {'n/a':>13} {'n/a':>16}")
            continue
        print(f"{baseline:<15} {s['n']:>5} {s['policy_violation_rate']:>15.3f} "
              f"{s['mean_cost_usd']:>12.5f} {s['mean_quality']:>13.3f} {s['mean_latency_ms']:>16.1f}")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python experiments/analyze_fair_quality.py <results.csv>")
        return 1

    csv_path = Path(sys.argv[1])
    by_baseline = load_results(csv_path)

    if "made" not in by_baseline:
        print("no 'made' baseline rows found in this CSV")
        return 1

    made_rows = by_baseline["made"]
    made_ok_ids = {r["scenario_id"] for r in made_rows if r["status"] == "ok"}
    made_abstain_ids = {r["scenario_id"] for r in made_rows if r["status"] != "ok"}

    print(f"MADE selected in {len(made_ok_ids)}/{len(made_rows)} scenarios, "
          f"abstained (no_selection/failed) in {len(made_abstain_ids)}.")

    paired = {b: [r for r in rows if r["scenario_id"] in made_ok_ids]
              for b, rows in by_baseline.items()}
    print_table("Paired comparison (same scenarios MADE selected on):", paired)

    if made_abstain_ids:
        abstained = {b: [r for r in rows if r["scenario_id"] in made_abstain_ids]
                     for b, rows in by_baseline.items() if b != "made"}
        print_table("What baselines did on the scenarios MADE abstained on:", abstained)

    return 0


if __name__ == "__main__":
    sys.exit(main())
