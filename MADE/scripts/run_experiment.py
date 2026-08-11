"""Run the full MADE vs baseline comparison experiment using real DeepSeek/Ollama API calls.

Prerequisites:
  - DEEPSEEK_API_KEY set in .env
  - OPA installed and on PATH
  - Ollama running locally (`ollama serve`) with any Ollama-provider candidate model pulled,
    if the target dataset includes one (e.g. gemma4-12b for v2.jsonl)
  - experiments/scenarios/<version>.jsonl generated (python experiments/generate_scenarios.py)

Note: score_cache is keyed by (scenario_id, candidate_id) only, not dataset
version. v1.jsonl and v2.jsonl share scenario_ids and prompts, so running
v2 against the same --db-path as a prior v1 run will silently REUSE v1's
already-cached DeepSeek scores (valid, since prompts are identical) and
only call the API fresh for any new candidate (e.g. gemma4-12b). This is
usually fine and saves API cost, but if you want v2's DeepSeek scores
measured fresh (e.g. to avoid mixing measurement times across runs in your
analysis), pass a distinct --db-path, e.g. --db-path made_v2.db.

Run:
  python scripts/run_experiment.py --dataset-version v1
"""
import argparse
from pathlib import Path

from dotenv import load_dotenv

from core.experiment.config_loader import load_ahp_weights, load_candidates_config
from core.experiment.harness import load_scenarios, run_experiment
from core.experiment.metrics import compute_baseline_summary, export_results_csv
from storage.db import get_session, make_engine

REPO_ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    load_dotenv(REPO_ROOT / ".env")

    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-version", default="v1")
    parser.add_argument("--db-path", type=Path, default=REPO_ROOT / "made.db")
    parser.add_argument("--output-csv", type=Path, default=None)
    args = parser.parse_args()

    output_csv = args.output_csv or REPO_ROOT / "experiments" / "results" / f"{args.dataset_version}.csv"

    scenarios = load_scenarios(REPO_ROOT / "experiments" / "scenarios" / f"{args.dataset_version}.jsonl")
    candidates_config = load_candidates_config(REPO_ROOT / "config" / "candidates.yaml")
    ahp_weights = load_ahp_weights(REPO_ROOT / "experiments" / "ahp_weights.yaml")

    print(f"Running experiment: {len(scenarios)} scenarios, dataset version {args.dataset_version!r}")

    engine = make_engine(args.db_path)
    with get_session(engine) as session:
        run_ids = run_experiment(session, scenarios, candidates_config, ahp_weights, args.dataset_version)
        for baseline, run_id in run_ids.items():
            summary = compute_baseline_summary(session, run_id)
            print(f"{baseline}: {summary}")
        export_results_csv(session, run_ids, output_csv)

    print(f"\nResults exported to {output_csv}")


if __name__ == "__main__":
    main()
