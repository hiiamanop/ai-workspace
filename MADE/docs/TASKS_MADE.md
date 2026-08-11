# Task Breakdown — MADE (Multi-Objective Agent Decision Engine)

Status: Draft v1 · Tanggal: 2026-08-08 · Terkait: `docs/PRD_MADE.md`, jadwal proposal Bagian 8 (`Proposal_Penelitian_EPM_MODM.md`)

Setiap task dipetakan ke fase jadwal 24-minggu proposal agar progres implementasi bisa dilacak terhadap timeline tesis. Ini adalah breakdown kerja teknis; rencana implementasi langkah-demi-langkah yang lebih rinci disusun terpisah (lihat catatan di akhir dokumen).

## Fase 3 — Desain EPM (Minggu 5-6)
- [ ] T1. Setup repo skeleton: `core/`, `api/`, `policies/`, `storage/`, `experiments/`, `pyproject.toml`, dependency (FastAPI, Pydantic, SQLModel, numpy).
- [ ] T2. Install & verifikasi OPA binary bisa dipanggil dari environment dev.
- [ ] T3. Tulis `policies/hard/compliance.rego`, `security.rego`, `privacy.rego`, `cost.rego`, `approval.rego` versi awal (aturan minimal representatif, bukan lengkap) + `*_test.rego` masing-masing.
- [ ] T4. Implementasi `core/epm/loader.py`: baca+validasi `epm.yaml`, jalankan OPA per kandidat, kembalikan `EvalResult`.

## Fase 4 — Instance Kebijakan (Minggu 7-8)
- [ ] T5. Susun `policies/epm.yaml` v1 dengan objective cost/quality/latency/business_risk dan bobot awal.
- [ ] T6. Susun 3-5 skenario kebijakan uji (budget, privasi, compliance, ambang human-approval) sebagai kasus untuk `*_test.rego`.

## Fase 5 — Formulasi MODM (Minggu 9-10)
- [ ] T7. Implementasi `core/modm/weighted_sum.py` + unit test numerik.
- [ ] T8. Implementasi `core/modm/topsis.py` + unit test numerik.
- [ ] T9. Definisikan interface `Ranking`/`Objective` yang dipakai bersama oleh kedua teknik.

## Fase 6 — Desain Algoritma (Minggu 11-12)
- [ ] T10. Implementasi `core/decision/engine.py`: gabungkan epm→modm, tentukan `decision_kind` handling (model/tool/approval).
- [ ] T11. Integration test end-to-end `core/decision` dengan OPA nyata (skenario: semua lolos, sebagian deny, approval-required).

## Fase 7 — Prototipe v1 (Minggu 13-14)
- [ ] T12. Implementasi `api/main.py` (FastAPI): endpoint `POST /decide`, `GET /policies/{policy_set}`.
- [ ] T13. Implementasi `storage/` (SQLModel models + migrasi sederhana), catat setiap keputusan ke tabel `decisions`.
- [ ] T14. Uji fungsional manual: panggil `/decide` untuk pemilihan model AI end-to-end dengan kandidat model API riil (GPT/Claude).

## Fase 8 — Prototipe v2 (Minggu 15-16)
- [ ] T15. Perluas kandidat ke tool selection (daftar tool representatif via config).
- [ ] T16. Uji fungsional end-to-end mencakup ketiga jenis keputusan (model, tool, human-approval).

## Fase 9 — Dataset Eksperimen (Minggu 17)
- [ ] T17a. Implementasi `core/experiment/deepseek_client.py` (panggil DeepSeek v4-flash/v4-pro riil, cost+latency dari respons, retry-lalu-skip) + `core/experiment/judge.py` (v4-pro sebagai judge tunggal, skor quality 0-1).
- [ ] T17b. Implementasi `core/experiment/score_cache.py` (tabel `score_cache`, cache-check sebelum panggil API).
- [ ] T17c. Tambah `deepseek-v4-flash`/`deepseek-v4-pro` ke `config/candidates.yaml`; susun `experiments/generate_scenarios.py` → `experiments/scenarios/v1.jsonl` (100+ skenario: task_type × data_classification × budget_level × template prompt, terinspirasi metodologi Nowak 2026).
- [ ] T18. Susun `experiments/ahp_weights.yaml` untuk baseline AHP-SAW (bobot terpisah dari `epm.yaml`).

## Fase 10 — Eksperimen (Minggu 18)
- [ ] T19. Implementasi `core/experiment/baselines.py`: `select_made`, `select_ahp_saw`, `select_always_strong`, `select_always_cheap`, `select_no_policy` — beroperasi di atas skor dari `score_cache`.
- [ ] T20. Implementasi `core/experiment/harness.py`: isi cache dari dataset → jalankan kelima strategi → ground-truth violation check via OPA untuk kandidat pilihan tiap strategi → hitung metrik → simpan ke `experiment_runs`/`experiment_results`.
- [ ] T21. Endpoint `POST /experiment/run` + `scripts/run_experiment.py` (jalankan run penuh dengan API DeepSeek sungguhan, ekspor CSV).

## Fase 11 — Analisis Hasil (Minggu 19-20)
- [ ] T22. Notebook analisis (pandas) atas CSV hasil eksperimen: policy violation rate, cost, quality, latency per baseline.
- [ ] T23. Uji statistik perbandingan MADE vs tiap baseline (paired test per metrik, mis. Wilcoxon signed-rank untuk metrik kontinu, proporsi/McNemar untuk violation rate — di luar scope service, analisis terpisah).

## Catatan

- Task di atas adalah breakdown tingkat fitur/modul, bukan rencana step-by-step siap-eksekusi. Untuk mulai coding, rencana implementasi rinci (file-by-file, urutan commit, kriteria selesai per task) sebaiknya disusun lewat proses `writing-plans` sebelum eksekusi dimulai — beri tahu saya kapan Anda siap masuk ke tahap itu.
