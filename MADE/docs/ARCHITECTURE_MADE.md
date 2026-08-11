# Architecture — MADE (Multi-Objective Agent Decision Engine)

Status: Draft v1 · Tanggal: 2026-08-08 · Terkait: `docs/PRD_MADE.md`

## 1. Gambaran Umum

```
                        ┌─────────────────────────────┐
                        │        MADE Service          │
                        │      (FastAPI, Python)       │
                        │                               │
  Agent Orchestrator    │  ┌─────────┐   ┌───────────┐  │
  (LangGraph/CrewAI/    │─▶│   API    │──▶│   core/    │  │
   eksperimen script)   │  │  layer   │   │  (package) │  │
                        │  └─────────┘   └─────┬─────┘  │
                        │                       │        │
                        │        ┌──────────────┼────────┴──┐
                        │        ▼              ▼           ▼
                        │   ┌────────┐    ┌───────────┐ ┌──────────┐
                        │   │  epm   │    │   modm    │ │experiment│
                        │   │(loader+│    │(filter +  │ │(harness+ │
                        │   │  OPA)  │    │ TOPSIS/WS)│ │ baseline)│
                        │   └───┬────┘    └───────────┘ └──────────┘
                        │       │                               │
                        └───────┼───────────────────────────────┘
                                ▼
                       OPA binary (subprocess/HTTP)  +  SQLite
                       policy repo (.rego + .yaml, version-controlled)
```

**Alur singkat**: orchestrator memanggil `POST /decide` dengan konteks task dan kandidat → API layer meneruskan ke `core.decision` → `epm` menjalankan hard constraint via OPA untuk menyaring kandidat yang valid dan menandai kebutuhan human-approval → `modm` menjalankan weighted-sum/TOPSIS pada kandidat yang lolos, memakai soft preference dari EPM sebagai bobot objective → hasil dikembalikan ke caller dan dicatat ke SQLite untuk analisis eksperimen.

Prinsip desain: **core logic sebagai Python package murni** (`core/`), testable in-process tanpa HTTP; `api/` hanya lapisan tipis pemetaan request/response. Ini memungkinkan `core` dipakai langsung dari harness eksperimen tanpa overhead network saat menjalankan ratusan skenario batch.

## 2. Komponen

### 2.1 `core/epm/` — Policy loader & evaluator
- Baca `policies/epm.yaml` (manifest soft preference) dan `policies/hard/*.rego` (hard constraint).
- Jalankan OPA (subprocess `opa eval` atau HTTP ke OPA server lokal) per kandidat dengan input sesuai kontrak §3.2 `SCHEMA_MADE.md`.
- API: `evaluate_hard_constraints(task, candidates) -> list[EvalResult]` (masing-masing berisi allow/deny_reasons/requires_approval), `get_objectives(policy_set) -> list[Objective]` (nama, arah, bobot).
- Validasi `epm.yaml` saat startup (Pydantic) — gagal start jika bobot/objective tidak valid.

### 2.2 `core/modm/` — Multi-objective optimization engine
- Input: kandidat yang lolos hard constraint + skor tiap kandidat per objective + bobot dari EPM.
- Dua teknik dengan interface sama: `weighted_sum(candidates, objectives) -> Ranking`, `topsis(candidates, objectives) -> Ranking`.
- Teknik yang dipakai per policy_set ditentukan field `technique` di `epm.yaml`.

### 2.3 `core/decision/` — Orchestration layer
- Menggabungkan `epm` + `modm` menjadi satu alur: filter → rank → pilih kandidat teratas.
- Menentukan `decision_kind` (model_selection/tool_selection/human_approval) dan meneruskan ke sub-alur yang sesuai — ketiganya memakai mesin filter+rank yang sama, hanya berbeda set kandidat dan file rego yang relevan.
- `requires_human_approval` dihasilkan langsung dari evaluasi `policies/hard/approval.rego`, bukan heuristik terpisah di Python.

### 2.4 `core/experiment/` — Evaluation harness

- `deepseek_client.py` — panggil DeepSeek API (OpenAI-compatible, via `httpx`) untuk `deepseek-v4-flash`/`deepseek-v4-pro`; kembalikan cost riil (dari `usage`), latency riil (wall-clock), teks respons. Retry 2-3x dengan backoff untuk error transient, lalu menyerah (tidak menggagalkan seluruh run).
- `ollama_client.py` — panggil Ollama lokal (endpoint OpenAI-compatible `/v1/chat/completions`, tanpa auth) untuk model self-hosted (mis. `gemma4-12b`); `cost_usd` selalu 0. Modul terpisah dari `deepseek_client.py`, bukan digeneralisasi — lihat `DESIGN_MADE.md` §14 (prinsip: satu client kecil per provider model AI).
- `judge.py` — panggil `deepseek-v4-pro` dengan rubric tetap untuk menilai respons (dari kandidat manapun, provider manapun) jadi skor quality 0-1, dipakai sebagai judge tunggal (konsisten across dataset, bukan self-judging acak).
- `score_cache.py` — cache `(scenario_id, candidate_id) -> skor lengkap` di tabel `score_cache` (lihat `SCHEMA_MADE.md` §6.2); dicek dulu sebelum memanggil `deepseek_client`/`ollama_client`/`judge`, supaya re-run tidak membayar API lagi (dan tidak memanggil Ollama lokal berulang tanpa perlu).
- `baselines.py` — 5 strategi seleksi dengan interface sama, beroperasi di atas skor yang sudah di-cache (bukan memanggil API sendiri): `select_made` (engine sungguhan, hard filter + MODM), `select_ahp_saw` (weighted-sum bobot expert statis dari `ahp_weights.yaml`, tanpa hard filter), `select_always_strong` (skor quality tertinggi), `select_always_cheap` (cost terendah), `select_no_policy` (weighted-sum bobot sama rata, tanpa hard filter).
- `harness.py` — orkestrasi penuh: warmup kandidat Ollama (lihat `DESIGN_MADE.md` §16) → isi cache dari dataset skenario (lihat `SCHEMA_MADE.md` §4), memilih `deepseek_client`/`ollama_client` per kandidat berdasarkan field `provider` di `config/candidates.yaml` → jalankan kelima strategi → untuk kandidat yang dipilih **strategi manapun**, cek ulang lewat `evaluate_hard_constraints` (ground-truth violation check — independen dari apakah strategi itu sendiri policy-aware) → hitung metrik (policy violation rate, cost, quality, latency, lihat §6 `PRD_MADE.md`) → simpan ke `experiment_runs`/`experiment_results` → ekspor CSV.

Prinsip kunci: tiap provider model AI riil dipanggil **satu kali per (scenario, kandidat riil)**, bukan per strategi — kelima strategi membandingkan pilihan mereka atas data kandidat yang identik, hanya algoritma seleksinya yang berbeda. Ini menjaga keadilan perbandingan sekaligus mengontrol biaya API riil.

### 2.5 `api/` — FastAPI HTTP layer
- Endpoint: `POST /decide`, `GET /policies/{policy_set}` (introspeksi), `POST /experiment/run` (trigger harness).
- Tidak ada business logic — hanya validasi request (Pydantic), panggil `core`, serialisasi response.

### 2.6 `storage/` — Persistence
- SQLite via SQLModel. Tabel: `decisions`, `experiment_runs`, `experiment_results`, `score_cache` (lihat `SCHEMA_MADE.md` §6).
- EPM sendiri **tidak** disimpan di DB — tetap file-based di `policies/` agar version-control (git) jadi source of truth kebijakan; `policy_version` di setiap keputusan mengacu ke git SHA folder `policies/`.

## 3. Tech Stack

- **Bahasa/framework**: Python 3.11+, FastAPI, Pydantic v2, SQLModel (SQLite).
- **Policy engine**: Open Policy Agent (OPA), dipanggil sebagai subprocess (`opa eval`) atau HTTP lokal — dipilih saat implementasi berdasarkan kemudahan testing (`opa test` untuk unit test rego).
- **MODM**: `numpy`/`scipy` untuk TOPSIS dan weighted-sum (tidak perlu library MCDM eksternal — implementasi keduanya cukup pendek untuk ditulis langsung).
- **Eksperimen/analisis**: `pandas` untuk agregasi hasil, ekspor CSV; visualisasi/statistik dilakukan di notebook terpisah (di luar cakupan service). `httpx` untuk panggilan DeepSeek API (sudah jadi dependency, tidak perlu SDK baru); `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` dibaca dari `.env` (gitignored).

## 4. Error Handling

- OPA unreachable/timeout → HTTP 503, fail-closed (tidak pernah fallback ke "allow all").
- Rego/`epm.yaml` invalid saat startup → service gagal start dengan pesan field/file yang error (fail-fast).
- Semua kandidat ter-deny → HTTP 200, `selected_candidate_id: null`, `excluded` berisi semua alasan (keputusan valid, bukan error).
- DeepSeek API gagal (timeout/rate limit) setelah retry 2-3x → skenario ditandai `status: 'failed'` di `experiment_results`, harness lanjut ke skenario berikutnya (tidak menggagalkan seluruh run 100+ skenario).
- `DEEPSEEK_API_KEY` kosong/tidak ada → harness gagal start dengan pesan jelas, bukan gagal diam-diam di tengah run.
- Judge mengembalikan output yang tidak bisa di-parse jadi skor → retry sekali, kalau tetap gagal skenario ditandai `failed` (tidak default ke skor tengah, supaya tidak mencemari metrik).

## 5. Testing Strategy

- `core/epm`: `opa test` pada `policies/hard/*_test.rego` (native OPA unit test).
- `core/modm`: unit test numerik (weighted-sum & TOPSIS) dengan expected ranking yang dihitung manual.
- `core/decision`: integration test end-to-end dengan OPA nyata (bukan mock), skenario: semua lolos, sebagian deny, approval-required.
- `core/experiment`: `deepseek_client`/`judge` diuji dengan mock HTTP response (bukan API riil — test suite tetap gratis/cepat/deterministic); `score_cache` diuji dengan SQLite roundtrip nyata; `baselines` diuji numerik dengan skor buatan; `harness` diuji integrasi dengan cache terisi manual + OPA nyata (tanpa panggilan API sungguhan). Run dengan API DeepSeek sungguhan dijalankan manual lewat `scripts/run_experiment.py`, bukan bagian dari `pytest`.
- `api/`: test tipis, hanya mapping request/response.
