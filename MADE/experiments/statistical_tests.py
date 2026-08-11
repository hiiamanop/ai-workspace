"""Paired statistical comparison of MADE vs each baseline, from an experiment
results CSV (produced by core.experiment.metrics.export_results_csv).

Run:
  python experiments/statistical_tests.py experiments/results/v1.csv
"""
import sys
from pathlib import Path

from scipy import stats

from experiments.analyze_results import load_results

METRICS = ["cost_usd", "quality_score", "latency_ms"]


def paired_values(by_baseline: dict[str, list[dict]], baseline: str, metric: str) -> tuple[list[float], list[float]]:
    made_by_scenario = {r["scenario_id"]: r for r in by_baseline["made"] if r["status"] == "ok"}
    other_by_scenario = {r["scenario_id"]: r for r in by_baseline[baseline] if r["status"] == "ok"}
    common_ids = sorted(set(made_by_scenario) & set(other_by_scenario))

    made_values = [float(made_by_scenario[sid][metric]) for sid in common_ids]
    other_values = [float(other_by_scenario[sid][metric]) for sid in common_ids]
    return made_values, other_values


def compare_baseline(by_baseline: dict[str, list[dict]], baseline: str) -> dict:
    result: dict = {"baseline": baseline}
    for metric in METRICS:
        made_values, other_values = paired_values(by_baseline, baseline, metric)
        if len(made_values) < 2 or made_values == other_values:
            result[metric] = {"n": len(made_values), "p_value": None}
            continue
        statistic, p_value = stats.wilcoxon(made_values, other_values)
        result[metric] = {"n": len(made_values), "statistic": statistic, "p_value": p_value}
    return result


def _is_violation(row: dict) -> bool:
    return row["policy_violation"] in ("True", "true", "1")


def mcnemar_violation(by_baseline: dict[str, list[dict]], baseline: str) -> dict:
    """Exact McNemar's test on paired violation/no-violation outcomes (binary,
    so Wilcoxon doesn't apply). b/c are the discordant pairs; only those
    carry information about which strategy violates policy more often."""
    made_by_scenario = {r["scenario_id"]: r for r in by_baseline["made"] if r["status"] == "ok"}
    other_by_scenario = {r["scenario_id"]: r for r in by_baseline[baseline] if r["status"] == "ok"}
    common_ids = sorted(set(made_by_scenario) & set(other_by_scenario))

    b = sum(1 for sid in common_ids  # made violates, other doesn't
            if _is_violation(made_by_scenario[sid]) and not _is_violation(other_by_scenario[sid]))
    c = sum(1 for sid in common_ids  # other violates, made doesn't
            if not _is_violation(made_by_scenario[sid]) and _is_violation(other_by_scenario[sid]))

    if b + c == 0:
        return {"n": len(common_ids), "b": b, "c": c, "p_value": None}
    p_value = stats.binomtest(min(b, c), b + c, 0.5, alternative="two-sided").pvalue
    return {"n": len(common_ids), "b": b, "c": c, "p_value": p_value}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python experiments/statistical_tests.py <results.csv>")
        return 1

    by_baseline = load_results(Path(sys.argv[1]))
    other_baselines = [b for b in by_baseline if b != "made"]

    for baseline in sorted(other_baselines):
        comparison = compare_baseline(by_baseline, baseline)
        print(f"\nmade vs {baseline}:")
        for metric in METRICS:
            m = comparison[metric]
            if m["p_value"] is None:
                print(f"  {metric}: n={m['n']} (not enough variation for test)")
            else:
                print(f"  {metric}: n={m['n']} p={m['p_value']:.4f}")

        mc = mcnemar_violation(by_baseline, baseline)
        if mc["p_value"] is None:
            print(f"  policy_violation (McNemar exact): n={mc['n']} b={mc['b']} c={mc['c']} (no discordant pairs)")
        else:
            print(f"  policy_violation (McNemar exact): n={mc['n']} b={mc['b']} c={mc['c']} p={mc['p_value']:.4f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
