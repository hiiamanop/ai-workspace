"""Generate MADE experiment scenarios: task_type x data_classification x
budget_level x region combinations, with a fixed prompt per task_type.

Run:
  python experiments/generate_scenarios.py --count 120 --seed 42
"""
import argparse
import itertools
import json
import random
from pathlib import Path

TASK_TEMPLATES = [
    ("summarization", "Ringkas laporan kuartalan berikut dalam 3 poin utama: pendapatan naik 12%, biaya operasional turun 5%, ekspansi ke dua pasar baru direncanakan tahun depan."),
    ("summarization", "Ringkas notulen rapat berikut: tim sepakat menunda peluncuran fitur X ke Q3, menambah anggaran marketing 15%, dan merekrut dua engineer baru."),
    ("contract_review", "Tinjau klausul berikut untuk risiko hukum: pihak kedua berhak membatalkan kontrak sepihak dengan pemberitahuan 7 hari tanpa kompensasi."),
    ("contract_review", "Tinjau klausul kerahasiaan berikut: informasi rahasia hanya dilindungi selama 6 bulan setelah kontrak berakhir."),
    ("automation", "Buat langkah-langkah untuk memindahkan file log lama ke folder arsip setiap malam."),
    ("automation", "Jelaskan langkah untuk membersihkan cache aplikasi secara otomatis setiap minggu."),
    ("customer_support", "Balas keluhan pelanggan berikut dengan sopan: 'Pesanan saya belum sampai setelah 10 hari, saya kecewa.'"),
    ("customer_support", "Jawab pertanyaan pelanggan berikut: 'Apakah produk ini bisa dikembalikan dalam 30 hari?'"),
]

DATA_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"]

BUDGET_LEVELS = {
    "generous": 1.0,
    "tight": 0.01,
    "very_tight": 0.0005,
}

REGIONS = ["us", "eu"]

REAL_CANDIDATES = ["deepseek-v4-flash", "deepseek-v4-pro"]

SYNTHETIC_DENY_CANDIDATE = {
    "id": "local-llama",
    "vendor": "unverified-oss",
    "kind": "model",
    "cost_per_1k_tokens": 0.0,
    "scores": {"cost": 0.0, "quality": 0.5, "latency": 2000.0, "business_risk": 0.4},
}


def generate_scenarios(count: int, seed: int, real_candidates: list[str] | None = None) -> list[dict]:
    real_candidates = real_candidates if real_candidates is not None else REAL_CANDIDATES
    rng = random.Random(seed)
    combos = list(itertools.product(TASK_TEMPLATES, DATA_CLASSIFICATIONS, BUDGET_LEVELS.items(), REGIONS))
    rng.shuffle(combos)

    scenarios = []
    for i, ((task_type, prompt), data_classification, (_budget_label, budget_value), region) in enumerate(
        combos[:count]
    ):
        scenarios.append({
            "scenario_id": f"s-{i + 1:03d}",
            "task": {"type": task_type, "data_classification": data_classification},
            "prompt": prompt,
            "real_candidates": real_candidates,
            "synthetic_candidates": [SYNTHETIC_DENY_CANDIDATE],
            "org": {"budget_remaining_usd": budget_value, "region": region},
            "policy_set": "default",
        })
    return scenarios


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=120)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "scenarios" / "v1.jsonl")
    parser.add_argument("--real-candidates", type=str, default=None,
                        help="Comma-separated candidate ids, e.g. deepseek-v4-flash,deepseek-v4-pro,gemma4-12b")
    args = parser.parse_args()

    real_candidates = args.real_candidates.split(",") if args.real_candidates else None
    scenarios = generate_scenarios(args.count, args.seed, real_candidates=real_candidates)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as f:
        for scenario in scenarios:
            f.write(json.dumps(scenario) + "\n")

    print(f"Generated {len(scenarios)} scenarios to {args.output}")


if __name__ == "__main__":
    main()
