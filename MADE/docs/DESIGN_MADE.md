# Design Rationale — MADE (Multi-Objective Agent Decision Engine)

Status: Draft v1 · Tanggal: 2026-08-08 · Terkait: `docs/PRD_MADE.md`, `docs/ARCHITECTURE_MADE.md`

Dokumen ini mencatat keputusan desain dan alternatif yang dipertimbangkan, agar rasionalnya tidak hilang saat implementasi maupun saat menulis bab metodologi tesis.

## 1. Bentuk sistem: Service/API, bukan library murni

**Dipilih**: FastAPI service dengan endpoint `/decide`.
**Alternatif**: library in-process yang dipanggil langsung dari script eksperimen.
**Alasan**: proposal memposisikan MADE sebagai decision engine yang dipanggil orchestrator agent saat runtime — bentuk service lebih dekat ke skenario integrasi enterprise nyata yang dievaluasi (RQ2/RQ3), dan tetap memungkinkan pemanggilan in-process untuk harness eksperimen karena core logic dipisah sebagai package Python murni (lihat §2 di bawah).

## 2. Core logic sebagai package terpisah dari API layer

**Dipilih**: `core/` (epm, modm, decision, experiment) adalah package Python murni, testable tanpa HTTP; `api/` hanya lapisan tipis.
**Alasan**: harness eksperimen perlu menjalankan ratusan skenario batch — memanggil `core.decision` langsung menghindari overhead HTTP per skenario, sekaligus menjaga satu sumber kebenaran logic (tidak ada duplikasi antara "mode service" dan "mode batch").

## 3. EPM hard constraint: Rego/OPA sungguhan, bukan skema custom

**Dipilih**: hard constraint ditulis sebagai kebijakan Rego, dievaluasi via OPA.
**Alternatif**: skema YAML/JSON custom (mis. Pydantic model dengan operator perbandingan sendiri).
**Alasan**: proposal (Bagian 7, metodologi) secara eksplisit menyebut "extend formalisme policy-as-code seperti OPA/Rego", dan studi rujukan utama Tema B (Jackson 2025/S7) memakai OPA/Kyverno. Memakai OPA sungguhan membuat klaim EPM "machine-readable dan dapat ditegakkan" lebih kuat secara akademik, dan `opa test` memberi mekanisme unit test kebijakan yang sudah matang tanpa perlu dibangun sendiri.
**Trade-off yang diterima**: menambah dependency operasional (OPA binary/proses) dibanding skema custom — dianggap sepadan karena kesesuaiannya dengan klaim riset.

## 4. Soft preference terpisah dari hard constraint (`epm.yaml` vs `.rego`)

**Dipilih**: bobot objective (soft preference) di file YAML terpisah dari aturan Rego (hard constraint).
**Alasan**: ini justru inti kontribusi EPM menurut SLR — memisahkan constraint non-negotiable dari preferensi optimizable secara **eksplisit**, bukan mencampur keduanya sebagai kriteria compensatory seperti pada S1 (Nowak 2026). Representasi dua-file ini membuat pemisahan tersebut terlihat langsung di struktur data, bukan hanya di narasi.

## 5. Teknik MODM: Weighted-Sum + TOPSIS, Pareto ditunda

**Dipilih**: implementasi weighted-sum dan TOPSIS, keduanya bisa dipilih per `policy_set` via field `technique`.
**Alternatif dipertimbangkan**: tambah Pareto-based front sekaligus.
**Alasan**: jadwal proposal (Minggu 11-12) meminta "bandingkan teknik" dengan justifikasi teoretis — dua teknik dengan karakteristik berbeda (compensatory linear vs distance-based) sudah cukup untuk perbandingan bermakna tanpa menambah kompleksitas algoritma Pareto (yang menghasilkan *set* solusi non-dominated, bukan satu keputusan, sehingga perlu mekanisme pemilihan tambahan dari front). Pareto tetap disebut sebagai future work jika hasil awal menunjukkan weighted-sum/TOPSIS tidak memadai.

## 6. Baseline AHP-SAW memakai bobot terpisah dari EPM

**Dipilih**: `experiments/ahp_weights.yaml` terpisah dari `policies/epm.yaml`.
**Alasan**: agar perbandingan adil — baseline AHP-SAW merepresentasikan pendekatan compensatory murni dengan bobot expert statis (meniru S1/Nowak 2026), bukan MODM yang "menyamar" dengan hard filter dimatikan. Kalau keduanya pakai file bobot yang sama, hasil perbandingan bisa bias karena bobotnya sudah dirancang untuk MODM.

## 7. Human-approval sebagai flag, bukan workflow

**Dipilih**: `requires_human_approval` dihasilkan dari evaluasi `policies/hard/approval.rego`, dikembalikan sebagai boolean+alasan di response.
**Alasan**: proposal (Bagian 5, ruang lingkup) membatasi cakupan pada "keputusan kebutuhan human-approval", bukan implementasi mekanisme approval itu sendiri (UI, notifikasi, dsb). Ini tetap dievaluasi setara dengan hard constraint lain agar bisa diukur di metrik policy violation rate (mis. "task berisiko tinggi dieksekusi tanpa approval" terhitung sebagai violation).

## 8. Storage: SQLite + file-based, bukan Postgres

**Dipilih**: kebijakan (EPM) tetap file di git; log keputusan dan hasil eksperimen di SQLite.
**Alasan**: skala riset satu peneliti, tidak butuh concurrent write tinggi atau HA. SQLite cukup untuk ratusan-ribuan baris hasil eksperimen dan tidak menambah beban operasional (server DB terpisah) yang tidak sepadan untuk PoC. File-based EPM menjaga versioning kebijakan lewat git (auditability, sesuai semangat policy-as-code), bukan lewat tabel DB terpisah yang harus dibangun manual.

## 9. Skor kandidat DeepSeek: cost & latency riil, quality via LLM-judge, business_risk tetap sintetis

**Dipilih**: untuk kandidat `deepseek-v4-flash`/`deepseek-v4-pro`, cost & latency diambil dari respons API sungguhan; quality dinilai oleh `deepseek-v4-pro` sebagai judge tunggal (rubric tetap, skala 0-10 dinormalisasi ke 0-1); business_risk tetap nilai tetap per kandidat, bukan hasil pengukuran.
**Alasan**: cost dan latency adalah properti yang **objektif dan langsung terukur** dari satu API call (token usage × harga, wall-clock time) — memakainya secara riil membuat eksperimen lebih dekat ke metodologi Nowak (2026) yang jadi baseline pembanding utama (500 prompt bisnis riil). Quality tidak bisa diukur langsung, tapi bisa dinilai lewat LLM-judge — pola yang sudah umum di riset evaluasi LLM. Business_risk sebaliknya **secara definisi bukan properti yang observable dari satu respons API** (ini soal reputasi vendor, riwayat kepatuhan, dsb.) — memaksakannya jadi skor turunan LLM-judge akan menambah kompleksitas metodologis (rubric tambahan yang harus dijustifikasi) tanpa dasar yang kuat, jadi tetap dipertahankan sebagai nilai tetap seperti pada kandidat sintetis di v1.
**Trade-off yang diterima**: hasil eksperimen untuk cost/quality/latency menjadi non-deterministic secara mentah (jawaban API bisa sedikit berbeda antar panggilan) — dimitigasi dengan cache per (scenario_id, candidate_id) sehingga *within* satu dataset run, semua strategi membandingkan angka yang identik; run berikutnya (re-generate dataset baru) bisa menghasilkan angka absolut yang sedikit berbeda, tapi pola relatif antar-strategi tetap jadi fokus analisis (bukan angka absolut satu run).

## 10. Judge tunggal (deepseek-v4-pro) untuk semua respons, bukan self-judging per model

**Dipilih**: `deepseek-v4-pro` menilai kualitas respons dari **kedua** kandidat (v4-flash maupun v4-pro sendiri), bukan tiap model menilai responsnya sendiri.
**Alternatif dipertimbangkan**: self-judging (tiap model menilai responsnya sendiri) atau `deepseek-v4-flash` sebagai judge (lebih murah).
**Alasan**: judge tunggal dan konsisten across seluruh dataset menghindari confound "rubric judge berbeda-beda per kandidat" — kalau tiap model menilai dirinya sendiri, perbedaan skor quality antar-kandidat bisa mencerminkan perbedaan standar penilaian, bukan perbedaan kualitas jawaban sungguhan. v4-pro dipilih (bukan v4-flash) karena model yang lebih kapabel umumnya jadi pilihan wajar untuk peran judge di riset evaluasi LLM.
**Trade-off yang diterima**: risiko *self-preference bias* saat v4-pro menilai responsnya sendiri (berpotensi menilai lebih tinggi dari yang seharusnya) — dicatat eksplisit sebagai limitasi metodologi di bab hasil tesis, bukan diabaikan.

## 11. Definisi 4 baseline: beda algoritma seleksi, skor kandidat sumbernya sama

**Dipilih**: `ahp_saw` (weighted-sum bobot expert statis dari `ahp_weights.yaml`), `always_strong` (skor quality tertinggi), `always_cheap` (cost terendah), `no_policy` (weighted-sum bobot sama rata) — keempatnya **tanpa** filter hard constraint, beroperasi di atas skor kandidat yang sama persis dengan yang dipakai MADE (dari `score_cache`, lihat §9).
**Alasan**: `ahp_saw` merepresentasikan pendekatan MCDM compensatory murni (meniru S1/Nowak 2026) — beda dari `no_policy` yang merepresentasikan orchestrator generik tanpa tuning/kebijakan sama sekali (bobot sama rata, bukan expert-tuned). `always_strong`/`always_cheap` merepresentasikan heuristik naif yang umum dipakai tanpa MCDM sama sekali. Keempatnya berbagi sumber skor kandidat yang identik dengan MADE (bukan menghitung ulang secara independen) supaya perbedaan hasil murni berasal dari algoritma seleksi, bukan dari data yang berbeda.
**Ground-truth violation check**: karena keempat baseline ini tidak berkonsultasi dengan OPA sama sekali saat memilih, `harness.py` tetap mengevaluasi kandidat pilihan mereka lewat `evaluate_hard_constraints` **setelah** seleksi (lihat `ARCHITECTURE_MADE.md` §2.4) — ini yang memungkinkan metrik `policy_violation_rate` dihitung secara adil untuk semua strategi, termasuk yang tidak policy-aware.

## 12. Cache skor per (scenario, kandidat): kontrol biaya & determinism relatif

**Dipilih**: `score_cache` (SQLite) menyimpan hasil panggilan DeepSeek + judge per `(scenario_id, candidate_id)`, dicek sebelum memanggil API.
**Alasan**: pada skala 100+ skenario × 2 kandidat riil, tanpa cache setiap re-run harness (mis. setelah menemukan bug di logic agregasi) akan memanggil ulang API dan membayar lagi — tidak proporsional untuk iterasi pengembangan. Cache juga menjamin kelima strategi seleksi membandingkan angka yang identik untuk skenario yang sama (lihat §11), bukan hasil panggilan API yang berbeda-beda tiap strategi dipanggil.

## 13. Error handling eksperimen: retry-lalu-skip, bukan fail-fast

**Dipilih**: error API DeepSeek (timeout/rate limit) di-retry 2-3x dengan backoff, kalau tetap gagal skenario itu ditandai `status: 'failed'` dan harness lanjut ke skenario berikutnya.
**Alasan**: pada run 100+ skenario yang berjalan lama dan memakan biaya nyata, satu kegagalan transient di skenario ke-90 tidak boleh menghanguskan seluruh progres (waktu + biaya API) dari 89 skenario sebelumnya. Ini beda prinsip dari fail-closed pada `core/epm` (di mana error kebijakan **harus** menghentikan keputusan) — di sini yang gagal adalah pengumpulan data eksperimen, bukan gerbang kepatuhan produksi, jadi skip-dan-lanjutkan yang tepat, dengan jumlah skenario gagal dilaporkan eksplisit di ringkasan akhir (bukan disembunyikan).

## 14. Model AI riil kedua (Gemma-4 via Ollama): client provider terpisah, bukan generalisasi

**Dipilih**: `core/experiment/ollama_client.py` sebagai modul terpisah dari `deepseek_client.py`, masing-masing dengan fungsi `complete(model, prompt) -> CompletionResult` bertanda sama tapi implementasi independen (Ollama: tanpa auth, `cost_usd` selalu 0, endpoint lokal; DeepSeek: Bearer auth, pricing per model, endpoint cloud).
**Alternatif dipertimbangkan**: satu client generik OpenAI-compatible dengan parameter opsional (`api_key=None`, `pricing=None`) dipakai kedua provider.
**Alasan**: perbedaan riil antar provider (auth, pricing, endpoint) cukup berarti sehingga memaksakan satu fungsi menampung keduanya lewat parameter opsional adalah abstraksi prematur untuk selisih kode yang kecil (~50 baris per client). Modul terpisah tetap independently testable (mock HTTP per modul, tanpa saling mempengaruhi) dan lebih mudah dipahami sendiri-sendiri. **Prinsip ini berlaku untuk setiap model AI riil berikutnya yang ditambahkan** — satu client kecil per provider, bukan satu client generik yang terus tumbuh parameter opsionalnya.
**Dispatch**: `config/candidates.yaml` menambahkan field `provider: deepseek | ollama` per kandidat model; `core/experiment/harness.py` memilih `complete()` mana yang dipanggil berdasarkan field ini, bukan hardcode ke satu provider.

## 15. Gemma-4 lokal diperlakukan sebagai vendor terpercaya, bukan `unverified-oss`

**Dipilih**: kandidat `gemma4-12b` diberi `vendor: ollama-local` (bukan `unverified-oss` seperti kandidat sintetis `local-llama`), sehingga otomatis lolos `compliance.rego`/`privacy.rego` yang sudah ada — **tidak ada satu baris Rego pun yang perlu diubah**.
**Alasan**: karena inferensi berjalan sepenuhnya di infrastruktur lokal (data tidak pernah keluar mesin), risiko privasi/residensi data justru lebih rendah dibanding memanggil API cloud manapun — representasi kebijakan yang jujur untuk skenario ini adalah "vendor terpercaya", bukan "belum terverifikasi". `business_risk` diberi nilai 0.1 (lebih rendah dari `deepseek-v4-pro` di 0.15) mencerminkan keunggulan privasi ini sebagai nilai tetap, konsisten dengan §9 (business_risk tidak diukur, tapi ditetapkan berdasarkan karakteristik vendor).
**Implikasi metodologis**: ini menciptakan skenario uji yang menarik untuk EPM+MODM — trade-off nyata antara model lokal (gratis, privasi maksimal, kualitas/kecepatan mungkin lebih rendah) vs model cloud (berbayar, kualitas tinggi, privasi bergantung kepercayaan pada vendor).

## 16. Cold-start Ollama: warmup call di luar pengukuran, bukan diabaikan atau dibiarkan mencemari latency

**Dipilih**: panggilan pemanasan (`warmup_ollama_candidates`) dikirim sekali di awal `run_experiment`, sebelum loop skenario, hasilnya dibuang (tidak masuk `score_cache`).
**Alasan**: model harus dimuat ke VRAM pada panggilan pertama (~12 detik ekstra, sekali saja per periode idle), sedangkan DeepSeek (cloud, selalu "hangat") tidak punya biaya setara. Tanpa warmup, skenario pertama yang memakai Gemma-4 akan punya latency outlier yang bisa mengubah hasil ranking MODM untuk skenario itu secara artifisial — mengulang persis kelas masalah yang sudah diperbaiki di §5 (unit latency yang tidak sebanding antar kandidat). Warmup memastikan latency yang tercatat sebanding (apple-to-apple) dengan DeepSeek.

## 17. Dataset v2 terpisah dari v1, bukan regenerate v1

**Dipilih**: `experiments/scenarios/v1.jsonl` (2 kandidat riil, DeepSeek saja) tetap tidak disentuh; `experiments/scenarios/v2.jsonl` baru (3 kandidat riil: deepseek-v4-flash, deepseek-v4-pro, gemma4-12b) dibuat untuk eksperimen lanjutan.
**Alasan**: biaya API riil sudah dikeluarkan untuk run v1 — mengubah `v1.jsonl` setelah biaya itu dikeluarkan akan merusak provenance (file yang tercatat di git tidak lagi merepresentasikan dataset yang benar-benar dipakai untuk menghasilkan CSV yang sudah ada). Menjaga v1 tetap beku dan membuat v2 baru menjaga kedua hasil eksperimen (2-kandidat vs 3-kandidat) tetap bisa ditelusuri dan dibandingkan secara terpisah.
