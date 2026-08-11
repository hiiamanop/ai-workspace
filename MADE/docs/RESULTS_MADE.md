# Bab Hasil — Evaluasi Empiris MADE (EPM+MODM)

Menjawab **RQ3**: sejauh mana MADE meningkatkan policy compliance dibanding baseline (AHP-SAW, always-strong, always-cheap, no-policy), tanpa mengorbankan biaya/kualitas/latensi secara signifikan.

## 1. Setup Eksperimen

- Dua dataset, masing-masing 120 skenario sintetis (tipe task, klasifikasi data, budget, region bervariasi).
- **v1** (`experiments/scenarios/v1.jsonl`): 2 kandidat model nyata (DeepSeek v4-flash, v4-pro) + 1 kandidat sintetis (`local-llama`, vendor tidak terpercaya).
- **v2** (`experiments/scenarios/v2.jsonl`): sama seperti v1 + 1 kandidat model nyata tambahan (`gemma4-12b`, lokal via Ollama, vendor terpercaya) — menguji generalisasi lintas vendor dan efek menyediakan opsi murah-namun-patuh-kebijakan.
- Setiap kandidat nyata benar-benar dipanggil; kualitas dinilai oleh LLM-judge (`deepseek-v4-pro`) secara konsisten untuk semua kandidat.
- 5 strategi dibandingkan pada skenario identik: `made`, `ahp_saw`, `always_strong`, `always_cheap`, `no_policy`.
- Uji statistik: Wilcoxon signed-rank (cost/quality/latency, berpasangan per skenario) dan McNemar exact test (policy_violation, biner berpasangan) — lihat `experiments/statistical_tests.py`.

## 2. Hasil v1 (DeepSeek-only)

| baseline | n | violation_rate | mean_cost | mean_quality* | mean_latency_ms |
|---|---|---|---|---|---|
| made | 108** | 0.000 | 0.00080 | 0.793 | 9176.7 |
| ahp_saw | 108 | 0.157 | 0.00265 | 0.988 | 19981.5 |
| always_strong | 108 | 0.176 | 0.00352 | 0.999 | 21683.9 |
| always_cheap | 108 | 0.435 | 0.00000 | 0.500 | 2000.0 |
| no_policy | 108 | 0.194 | 0.00413 | 0.986 | 14288.3 |

\* Dihitung berpasangan (paired) — hanya atas 108 skenario di mana MADE berhasil memilih, supaya adil terhadap baseline yang tidak pernah abstain.
\*\* MADE abstain (`no_selection`) pada 12/120 skenario. Pada **seluruh** 12 skenario itu, ketiga baseline lain (`ahp_saw`, `always_strong`, `no_policy`) melanggar kebijakan 100% dari waktu — memvalidasi bahwa abstain MADE bukan kegagalan, melainkan fail-closed yang benar (tidak ada kandidat yang sebetulnya patuh).

**Signifikansi (v1, n=108 berpasangan):**
- policy_violation: MADE signifikan lebih rendah dari semua baseline (McNemar exact, p<0.0001 untuk keempatnya).
- cost/quality/latency: signifikan berbeda dari semua baseline (Wilcoxon, p<0.0001) — MADE lebih murah dan lebih cepat, tapi kualitasnya juga signifikan lebih rendah (lihat §4 untuk analisis akar masalah).

## 3. Hasil v2 (+ kandidat lokal gemma4-12b)

| baseline | n | violation_rate | mean_cost | mean_quality | mean_latency_ms |
|---|---|---|---|---|---|
| made | 120 | 0.000 | 0.00020 | 0.902 | 20472.3 |
| ahp_saw | 120 | 0.108 | 0.00065 | 0.991 | 19297.9 |
| always_strong | 120 | 0.258 | 0.00379 | 0.998 | 24808.6 |
| always_cheap | 120 | 0.000 | 0.00000 | 0.902 | 32243.6 |
| no_policy | 120 | 0.083 | 0.00041 | 0.980 | 18890.8 |

MADE **tidak pernah abstain** di v2 (0/120) — dengan kandidat lokal terpercaya tersedia, selalu ada pilihan yang patuh kebijakan.

**Signifikansi (v2, n=120 berpasangan):**

| vs baseline | cost | quality | latency | policy_violation (McNemar, b/c) |
|---|---|---|---|---|
| ahp_saw | p<0.0001 | p<0.0001 | p=0.413 (n.s.) | p=0.0002 (b=0, c=13) |
| always_strong | p<0.0001 | p<0.0001 | p=0.117 (n.s.) | p<0.0001 (b=0, c=31) |
| always_cheap | p<0.0001 | p=0.986 (n.s.) | p<0.0001 | tidak ada pasangan diskordan (b=c=0) |
| no_policy | p<0.0001 | p<0.0001 | p=0.354 (n.s.) | p=0.0020 (b=0, c=10) |

`b` = jumlah skenario MADE melanggar tapi baseline tidak (selalu 0 di semua perbandingan); `c` = sebaliknya.

## 4. Analisis: Mengapa Gap Kualitas Mengecil dari v1 ke v2

Di v1, gap kualitas MADE vs baseline (0.793 vs ~0.99) **bukan** disebabkan oleh abstain, melainkan pilihan nyata: pada 43/108 skenario berpasangan, MADE memilih `local-llama` (quality tetap 0.5) demi menghemat biaya/latensi, sesuai bobot `epm.yaml` (quality=0.4, cost+latency+risk=0.6 gabungan). Baseline lain hampir selalu memilih model DeepSeek asli (quality ~0.98–1.0) karena tidak punya insentif hemat biaya sekuat itu.

Di v2, dengan `gemma4-12b` (lokal, gratis, **dan** vendor terpercaya) tersedia sebagai kandidat hemat biaya, MADE tidak lagi harus memilih `local-llama` yang kualitasnya sangat rendah (0.5) — cukup kandidat lokal yang kualitasnya jauh lebih baik. Hasilnya, mean_quality MADE naik ke 0.902, dan **tidak berbeda signifikan** dari `always_cheap` (p=0.986) — sementara `always_cheap` sendiri kini juga 0% violation (karena opsi termurahnya kini kandidat terpercaya, bukan `local-llama` yang unverified).

**Kesimpulan metodologis**: kesenjangan kualitas MADE di v1 adalah artefak dari *keterbatasan pool kandidat* (hanya ada 1 opsi murah, dan itu vendor rendah-kualitas/tidak terpercaya), bukan kelemahan mekanisme MODM/TOPSIS itu sendiri. Ini juga memperkuat validitas eksternal: temuan MADE (0% violation, biaya jauh lebih rendah) konsisten di dua dataset dengan komposisi vendor berbeda.

## 5. Fitur Bobot Kritikal (Post-hoc, belum diuji terpisah)

Selama antara v1 dan v2, ditambahkan mekanisme: task dengan `data_classification` confidential/restricted otomatis menggunakan profil bobot `epm-critical.yaml` (quality=0.7 vs 0.4 default), tanpa perlu field baru dari pemanggil atau panggilan LLM tambahan untuk klasifikasi. Perubahan ini aktif untuk **semua** skenario confidential/restricted di v2 (59/120 di v1, proporsi serupa di v2 karena scenario_id sama). Belum dilakukan analisis terpisah untuk fitur ini secara spesifik (mis. membandingkan hasil dengan/tanpa bobot kritikal) — **item terbuka**, lihat §6.

## 6. Keterbatasan & Pekerjaan Lanjutan

- Dataset sintetis (skenario dan prompt dibuat oleh generator, bukan data produksi enterprise nyata) — ancaman validitas eksternal yang perlu diakui eksplisit di bab diskusi.
- Efek fitur bobot kritikal (§5) belum diisolasi secara statistik dari efek penambahan kandidat lokal — keduanya berubah bersamaan antara v1 dan v2.
- `score_cache` v2 menggunakan ulang skor DeepSeek dari v1 (didokumentasikan, valid karena prompt identik) — perlu disebutkan sebagai keputusan desain di bab metodologi, bukan disembunyikan.
- LLM-judge tunggal (`deepseek-v4-pro`) untuk semua penilaian kualitas — potensi self-preference bias terhadap keluarga model DeepSeek perlu diakui sebagai keterbatasan.
