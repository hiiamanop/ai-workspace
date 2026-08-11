# PRD — MADE (Multi-Objective Agent Decision Engine)

Status: Draft v1 · Tanggal: 2026-08-08 · Terkait: `Proposal_Penelitian_EPM_MODM.md`, `SLR_Kitchenham_EPM_MODM.md`

## 1. Latar Belakang & Masalah

Framework orkestrasi AI agent yang ada (LangGraph, CrewAI, AutoGen, Semantic Kernel) mengoptimasi task completion, bukan tujuan organisasi (biaya, kepatuhan, keamanan, privasi, human-approval). Tidak ada pemisahan eksplisit antara kebijakan yang mutlak (non-negotiable) dan preferensi yang bisa dikompromikan dalam proses pemilihan model/tool. Lihat `docs/Proposal_Penelitian_EPM_MODM.md` §1 untuk data pendukung dan §6/SLR untuk analisis gap literatur.

## 2. Tujuan Produk (PoC)

MADE adalah service yang menerima permintaan keputusan orkestrasi dari agent/orchestrator dan mengembalikan keputusan yang **sudah difilter oleh hard constraint kebijakan enterprise** dan **dioptimasi secara multi-objective** di antara opsi yang lolos. Ini adalah bukti keterlaksanaan (proof-of-concept) untuk EPM (Enterprise Policy Model) + MODM (Multi-Objective Decision Model) sesuai proposal tesis, Tujuan Penelitian #3.

## 3. Pengguna & Konteks Pemakaian

- **Pengguna langsung**: agent orchestrator (dipanggil via HTTP oleh LangGraph/CrewAI atau script eksperimen), bukan end-user manusia.
- **Pengguna tidak langsung**: peneliti (Anda) menjalankan eksperimen komparatif MADE vs baseline, dan pembimbing/penguji tesis yang mengevaluasi hasil.
- **Konteks**: dipakai per-request, sinkron, latensi rendah — dipanggil di tengah alur kerja agent sebelum agent mengeksekusi task dengan model/tool yang dipilih.

## 4. Cakupan Fungsional

1. **Pemilihan model AI** — dari kandidat model yang terdaftar, pilih yang lolos hard constraint dan optimal secara multi-objective.
2. **Pemilihan tool** — sama seperti di atas, untuk kandidat tool.
3. **Keputusan human-approval** — menandai apakah task/keputusan tertentu wajib melalui approval manusia sebelum dieksekusi (flag, bukan workflow approval).
4. **Manajemen kebijakan (EPM)** — memuat, memvalidasi, dan memversi kebijakan (hard constraint via Rego/OPA + soft preference via `epm.yaml`).
5. **Harness eksperimen** — menjalankan skenario task+kebijakan terhadap MADE dan baseline pembanding (AHP-SAW, always-strong/cheap, no-policy), menghitung metrik evaluasi. Untuk skenario `model_selection`, skor cost & latency diambil dari panggilan riil ke DeepSeek API (v4-flash, v4-pro) dan skor quality dinilai oleh DeepSeek v4-pro sebagai judge — bukan sepenuhnya sintetis (lihat §7).

## 5. Di Luar Cakupan (Out of Scope)

Mengikuti Bagian 5 proposal:
- Orkestrasi workflow penuh lintas-agent (multi-step business process orchestration).
- Ekstraksi otomatis kebijakan dari dokumen prosa (SOP, kontrak, regulasi) — EPM dikonstruksi manual/semi-terstruktur.
- Data produksi enterprise riil — evaluasi memakai skenario yang dikonstruksi peneliti.
- UI/workflow approval manusia sungguhan — MADE hanya mengeluarkan flag `requires_human_approval`.
- Deployment produksi (auth, multi-tenancy, high-availability) — ini PoC riset, bukan produk siap produksi.

## 6. Kriteria Sukses

Selaras dengan RQ3 proposal — dibandingkan baseline (AHP-SAW compensatory murni, always-strong/always-cheap, framework tanpa policy-awareness):
- **Policy violation rate** MADE lebih rendah secara signifikan.
- **Cost, quality/response sufficiency, latency** MADE tidak turun signifikan dibanding baseline (trade-off yang dapat diterima, bukan wajib lebih baik).
- Prototipe berjalan end-to-end pada seluruh skenario dataset eksperimen tanpa crash, dengan hasil yang reproducible (policy version + technique tercatat di setiap keputusan).

## 7. Asumsi Kunci

- **Engine inti (`core.decision.decide`, endpoint `/decide`) tidak berubah**: tetap menerima skor kandidat sebagai input dari caller, tidak pernah memanggil API model sendiri. Asumsi ini masih berlaku penuh untuk MADE sebagai service.
- **Harness eksperimen** (komponen baru, di luar engine inti) yang mengisi skor tersebut: untuk kandidat DeepSeek riil (`deepseek-v4-flash`, `deepseek-v4-pro`), cost & latency diambil dari respons API sungguhan, quality dinilai via LLM-judge (DeepSeek v4-pro), business_risk tetap nilai tetap per kandidat (bukan hasil pengukuran — lihat `DESIGN_MADE.md` §9). Kandidat sintetis (tool, dan model non-DeepSeek untuk uji jalur deny kebijakan) tetap pakai skor terprogram seperti semula.
- Hasil panggilan API di-cache per (scenario_id, candidate_id) — re-run harness tidak memanggil API ulang untuk pasangan yang sama, menjaga biaya & reproducibility.
- Satu instance MADE, satu `policy_set` aktif per waktu (tidak ada multi-tenant policy di PoC ini).
- OPA berjalan sebagai proses/sidecar lokal yang dapat diakses MADE (bukan cluster terdistribusi).

## 8. Dokumen Terkait

- Arsitektur & komponen: `docs/ARCHITECTURE_MADE.md`
- Skema data (EPM, API, DB): `docs/SCHEMA_MADE.md`
- Rasional desain & alternatif yang dipertimbangkan: `docs/DESIGN_MADE.md`
- Task breakdown implementasi: `docs/TASKS_MADE.md`
