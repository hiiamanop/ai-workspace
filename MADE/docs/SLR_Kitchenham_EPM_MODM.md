Systematic Literature Review

## Model Keputusan Multi-Objective yang Berbasis Kebijakan (Policy-Constrained) untuk Orkestrasi AI Agent di Lingkungan Enterprise

Disusun untuk mendukung penelitian tesis magister Ahmad Naufal Muzakki, Institut Teknologi Bandung, Program Studi Sistem dan Teknologi Informasi.

# **1\. Pendahuluan**

Systematic Literature Review (SLR) ini disusun mengikuti panduan Kitchenham & Charters (2007) untuk memetakan state-of-the-art dan mengidentifikasi celah riset (research gap) pada persimpangan tiga bidang: (1) model keputusan multi-objective/multi-kriteria untuk orkestrasi AI agent dan LLM, (2) representasi kebijakan enterprise yang machine-readable untuk governance AI, dan (3) arsitektur referensi untuk sistem agentic AI di lingkungan enterprise.

SLR ini menjadi dasar untuk memformulasikan research question tesis dan merancang skema Enterprise Policy Model (EPM) serta Multi-Objective Decision Model (MODM) pada tahap berikutnya. Model ini adalah sebuah model keputusan multi-objective yang membedakan kebijakan yang bersifat mutlak (hard constraint) dari preferensi yang bisa dikompromikan (soft preference), untuk keputusan pemilihan model AI, pemilihan tool, dan kebutuhan human-approval.

# **2\. Protokol Review (Kitchenham & Charters, 2007)**

## 2.1 Research Questions untuk SLR

- SLR-RQ1: Pendekatan pengambilan keputusan apa (rule-based, MCDM, optimasi, learning-based) yang telah diusulkan untuk memilih model AI, tool, atau jalur eksekusi dalam konteks enterprise/agentic AI, dan objective apa saja yang dioptimasi?
- SLR-RQ2: Bagaimana kebijakan organisasi (biaya, keamanan, kepatuhan, privasi, human-approval) direpresentasikan dan ditegakkan dalam sistem governance AI, dan sejauh mana representasi tersebut machine-readable serta terintegrasi ke proses pengambilan keputusan (bukan sekadar enforcement)?
- SLR-RQ3: Arsitektur referensi atau pola arsitektural apa yang telah diusulkan untuk sistem agentic AI skala enterprise, dan bagaimana arsitektur tersebut menangani governance, observability, dan pengambilan keputusan multi-objective?
- SLR-RQ4: Metode dan metrik apa yang digunakan untuk mengevaluasi secara empiris sistem routing/orkestrasi AI yang policy-aware atau multi-objective?
- SLR-RQ5: Celah riset apa yang muncul pada persimpangan antara representasi kebijakan enterprise formal dan model keputusan multi-objective untuk orkestrasi AI agent?

## 2.2 Strategi Pencarian

Basis data akademik yang menjadi target ideal: IEEE Xplore, ACM Digital Library, ScienceDirect, SpringerLink, Scopus, dan Web of Science, dilengkapi arXiv dan SSRN untuk cakupan preprint/working paper mengingat topik agentic AI governance masih sangat baru (mayoritas publikasi 2025-2026).

String pencarian konseptual (Boolean):

("agentic AI" OR "AI agent" OR "LLM" OR "large language model") AND ("orchestration" OR "routing" OR "model selection" OR "decision model") AND ("multi-objective" OR "multi-criteria" OR "MCDM" OR "policy-aware" OR "governance") AND ("enterprise" OR "organization\*")

String ini dipecah menjadi enam sub-tema pencarian bertarget (14 query independen dijalankan) untuk memastikan cakupan: (A) MCDM/multi-objective untuk routing LLM/agent, (B) representasi kebijakan dan policy-as-code untuk governance AI, (C) arsitektur referensi agentic AI enterprise, (D) evaluasi/benchmark orkestrasi agent, (E) MCDM klasik untuk seleksi layanan cloud/IT (landasan teori), dan (F) constrained multi-objective optimization (landasan teori hard/soft constraint).

## 2.3 Kriteria Inklusi dan Eksklusi

Kriteria Inklusi:

- IC1: Dipublikasikan atau dirilis sebagai preprint pada rentang 2015-2026, berbahasa Inggris.
- IC2: Membahas pengambilan keputusan, routing, seleksi, atau orkestrasi model/agent AI.
- IC3: Membahas minimal satu dari: optimasi multi-objective/multi-kriteria, representasi kebijakan/governance, atau arsitektur AI enterprise.
- IC4: Teks lengkap atau abstrak tersedia untuk ditinjau.

Kriteria Eksklusi:

- EC1: Konten pemasaran/blog vendor tanpa kontribusi metodologis.
- EC2: Fokus semata pada training/fine-tuning model tanpa sudut pandang orkestrasi/pengambilan keputusan.
- EC3: Studi duplikat (versi jurnal diprioritaskan atas versi preprint bila kontennya sama).
- EC4: Tidak tersedia dalam Bahasa Inggris atau Indonesia.

## 2.4 Kriteria Penilaian Kualitas (Quality Assessment)

Setiap studi dinilai menggunakan checklist berikut, dengan skor 0 (tidak terpenuhi), 0.5 (terpenuhi sebagian), atau 1 (terpenuhi penuh) per kriteria:

- QA1: Apakah tujuan/pertanyaan penelitian dinyatakan secara eksplisit?
- QA2: Apakah metodologi/desain studi dijelaskan secara memadai?
- QA3: Apakah terdapat evaluasi empiris (bukan sekadar whitepaper konseptual)?
- QA4: Apakah studi telah melalui proses peer-review?

Hasil penilaian kualitas per studi terintegrasi ke dalam kolom "Tipe Venue" pada tabel ekstraksi data di Bagian 4, karena berkorelasi kuat dengan QA4 dan menjadi indikator kekuatan bukti paling praktis untuk sintesis pada tahap ini.

## 2.5 Strategi Ekstraksi Data

Untuk setiap studi yang lolos seleksi, data diekstrak ke dalam bidang berikut: ID studi, sitasi (penulis, tahun, venue), fokus dan kontribusi utama, objective/kriteria keputusan yang dipertimbangkan, jenis representasi kebijakan (bila ada), dan celah (gap) yang relevan terhadap arah riset MODM+EPM.

**3\. Pelaksanaan Review (Conducting the Review)**

## 3.1 Alur Seleksi Studi

Empat belas query pencarian dijalankan lintas enam sub-tema, menghasilkan sekitar 140 hasil mentah (dengan tumpang tindih tinggi antar-query). Setelah deduplikasi, tersisa sekitar 75 rekaman unik. Setelah skrining judul/abstrak terhadap kriteria inklusi, sekitar 40 studi dipertimbangkan untuk peninjauan lebih lanjut. Setelah penerapan penuh kriteria inklusi/eksklusi dan penilaian kualitas, 24 studi primer dimasukkan ke dalam sintesis akhir. Angka-angka ini bersifat approximate mengingat sifat pencarian yang dijelaskan pada Bagian 2.2 dan 6.

## 3.2 Distribusi Tipe Venue

| **Tipe Venue**                          | **Jumlah Studi**                     | **Persentase** |
| --------------------------------------- | ------------------------------------ | -------------- |
| Jurnal / prosiding peer-review          | 7 (S1, S18, S20, S21, S22, S23, S24) | 29%            |
| Preprint (arXiv)                        | 12 (S2-S6, S8, S11-S13, S15-S17)     | 50%            |
| Working paper (SSRN, belum peer-review) | 2 (S7, S9)                           | 8%             |
| Dokumen framework industri/pemerintah   | 1 (S10)                              | 4%             |
| Venue tidak terverifikasi reputasinya   | 2 (S14, S19)                         | 8%             |

Tabel 1. Distribusi tipe venue dari 24 studi primer yang disertakan.

Temuan penting: 50% studi primer masih berupa preprint arXiv dan 8% berupa working paper SSRN yang belum melalui peer-review. Ini mengonfirmasi bahwa bidang "policy-aware/governance-integrated decision-making untuk agentic AI" masih sangat nascent secara akademik, sebuah sinyal positif untuk ruang kontribusi tesis ini, namun juga berarti temuan dari studi-studi tersebut perlu dibaca dengan tingkat kehati-hatian lebih tinggi dibanding hasil dari jurnal/prosiding yang sudah divalidasi peer-review.

## 3.3 Daftar Studi Primer

| **ID** | **Judul (disingkat)**                                                                   | **Tahun** | **Tipe Venue**                                |
| ------ | --------------------------------------------------------------------------------------- | --------- | --------------------------------------------- |
| S1     | A Multi-Criteria Decision Framework for Enterprise LLM Routing                          | 2026      | Jurnal (MDPI Information)                     |
| S2     | Bayesian Orchestration of Multi-LLM Agents                                              | 2026      | Preprint (arXiv)                              |
| S3     | Multi-Agent Routing as Set-Valued Prediction                                            | 2026      | Preprint (arXiv)                              |
| S4     | Causal LLM Routing: Regret Minimization from Observational Data                         | 2025      | Preprint (arXiv)                              |
| S5     | Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey               | 2026      | Preprint (arXiv)                              |
| S6     | One Head, Many Models: Cross-Attention Routing for Cost-Aware LLM Selection             | 2025      | Preprint (arXiv)                              |
| S7     | Governing Autonomous AI Agents with Policy-as-Code                                      | 2025      | Working paper (SSRN)                          |
| S8     | CAGE-1: Control, Assurance, and Governance Evaluation for Enterprise Agentic AI         | 2026      | Preprint (arXiv)                              |
| S9     | AI FinOps: A Governance Framework for Cost-Efficient Generative AI                      | 2026      | Working paper (SSRN)                          |
| S10    | Model AI Governance Framework for Agentic AI                                            | 2026      | Dokumen pemerintah (IMDA Singapura)           |
| S11    | Towards Agentic AI Governance: A Preliminary Assessment                                 | 2026      | Preprint (arXiv)                              |
| S12    | The Orchestration of Multi-Agent Systems: Architectures, Protocols, Enterprise Adoption | 2026      | Preprint (arXiv)                              |
| S13    | Context Engineering: From Prompts to Corporate Multi-Agent Architecture                 | 2026      | Preprint (arXiv)                              |
| S14    | Multi-Agent Architecture for Enterprise AI Orchestration                                | 2026      | Venue belum terverifikasi                     |
| S15    | Infrastructure for the Agentic Web: Gap Analysis and Architecture                       | 2026      | Preprint (arXiv)                              |
| S16    | Multi-Agent LLM Orchestration for Incident Response                                     | 2025      | Preprint (arXiv)                              |
| S17    | DecisionBench: A Benchmark for Emergent Delegation in Agentic Workflows                 | 2026      | Preprint (arXiv)                              |
| S18    | Multi-Agent Orchestration of Local LLMs for Contract Review                             | 2025      | Prosiding (ACM)                               |
| S19    | A Survey on MCDM Methods for Evaluating Cloud Computing Services                        | 2016      | Jurnal/prosiding                              |
| S20    | Adaptive Multi-Level Cloud Service Selection Using AHP-TOPSIS                           | 2025      | Jurnal (MDPI Applied Sciences)                |
| S21    | A Novel Framework for Cloud Service Evaluation Using Hybrid MCDM                        | 2018      | Jurnal (Springer)                             |
| S22    | Prioritizing Cloud Service Selection Using Integrated MCDM under Fuzzy Environment      | 2017      | Jurnal (Springer)                             |
| S23    | Handling Constrained Multiobjective Optimization Problems                               | 2019      | Jurnal (IEEE Trans. Evolutionary Computation) |
| S24    | A Generalized Framework for Multi-objective-based Constraint Handling Technique         | 2024      | Jurnal (Springer)                             |

Tabel 2. Daftar lengkap 24 studi primer terpilih, diurutkan berdasarkan ID sub-tema.

# **4\. Hasil dan Sintesis per Tema**

## 4.1 Tema A, Model MCDM/Multi-Objective untuk Routing LLM dan Agent

Enam studi (S1-S6) membahas pendekatan multi-kriteria atau multi-objective untuk memilih model AI. S1 (Nowak, 2026) adalah studi paling dekat dengan MODM yang direncanakan, sebuah framework AHP+SAW peer-review yang dievaluasi empiris. Namun kelima studi lainnya (S2-S6) menunjukkan bahwa arus utama riset routing LLM tetap didominasi perspektif teknis murni (cost, latency, akurasi) tanpa menyentuh dimensi kebijakan organisasi.

| **ID** | **Studi**                                                            | **Fokus & Kontribusi**                                                                                  | **Objective/Kriteria**                                                               | **Gap Relevan terhadap Riset Peneliti**                                                                                                                                  |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1     | Nowak (2026), Information (MDPI), jurnal peer-review                 | Framework MCDM (AHP+SAW) untuk routing LLM per-prompt di enterprise; evaluasi empiris 500 prompt bisnis | Accuracy, business risk, reasoning depth, cost, latency, standardization, creativity | Semua kriteria bersifat compensatory (SAW); tidak ada constraint non-negotiable; bobot AHP statis dari expert; hanya mencakup pemilihan model, tidak tool/human-approval |
| S2     | Bayesian Orchestration of Multi-LLM Agents (2026), arXiv, preprint   | Orkestrasi Bayesian untuk sequential decision-making multi-LLM yang cost-aware                          | Cost, akurasi/diversitas model                                                       | Fokus teknis murni; tidak ada representasi kebijakan organisasi atau constraint compliance                                                                               |
| S3     | Multi-Agent Routing as Set-Valued Prediction (2026), arXiv, preprint | Routing sebagai set-valued prediction dengan evaluasi cost-aware pada benchmark WildChat                | Cost, latency, kualitas routing                                                      | Tidak melibatkan kebijakan organisasi; evaluasi pada benchmark chat umum, bukan skenario enterprise                                                                      |
| S4     | Causal LLM Routing (2025), arXiv, preprint                           | Regret minimization end-to-end dari data observasional untuk routing kausal                             | Cost, performa                                                                       | Pendekatan causal inference murni teknis; tidak menyentuh governance/policy                                                                                              |
| S5     | Dynamic Model Routing and Cascading, Survei (2026), arXiv, preprint  | Survei paradigma routing/cascading LLM: difficulty-based, confidence, RL, dst.                          | Cost, latency, akurasi (bervariasi per metode)                                       | Survei ini sendiri mengonfirmasi dominasi perspektif teknis dan minimnya integrasi governance                                                                            |
| S6     | One Head, Many Models (2025), arXiv, preprint                        | Cross-attention routing berbasis cost-awareness untuk pemilihan LLM                                     | Cost, kualitas output                                                                | Tidak ada dimensi kebijakan/compliance; murni pendekatan learning-based                                                                                                  |

Tabel 3. Ekstraksi data studi Tema A.

## 4.2 Tema B, Representasi Kebijakan dan Governance untuk AI

Lima studi (S7-S11) membahas governance dan representasi kebijakan. Pola yang konsisten: representasi kebijakan yang ada (policy-as-code, cost economics model, prinsip governance) berfungsi sebagai enforcement atau accounting, bukan sebagai input formal ke mesin pengambilan keputusan multi-objective.

| **ID** | **Studi**                                                                                  | **Fokus & Kontribusi**                                                                                              | **Objective/Kriteria**                                      | **Gap Relevan terhadap Riset Peneliti**                                                                                          |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| S7     | Jackson (2025), SSRN, working paper                                                        | Arsitektur Policy-as-Code multi-layer (OPA/Kyverno) untuk risk, compliance, zero-trust pada agent otonom            | Risk scoring, kepatuhan (EU AI Act, NIST AI RMF, ISO 42001) | Fokus enforcement runtime, bukan decision-making/optimasi; evaluasi hanya simulasi; tidak terhubung ke multi-objective selection |
| S8     | Sure (2026), CAGE-1, arXiv, independent technical report                                   | Framework evaluasi kesiapan-deploy agent enterprise: authority, policy enforcement, tool safety, auditability, dst. | Bersifat checklist/assurance, bukan objective terukur       | Evaluasi kesiapan pra-deployment (gate), bukan mesin keputusan runtime; tidak ada model optimasi                                 |
| S9     | Lingamgunta (2026), SSRN, working paper                                                    | AI FinOps: model ekonomi biaya 6 dimensi, operating model, skema telemetri untuk akuntabilitas biaya AI             | Cost, akuntabilitas finansial, compliance                   | Kerangka akuntansi/organisasional; tidak ada mekanisme keputusan otomatis untuk orkestrasi                                       |
| S10    | IMDA Singapore, Model AI Governance Framework for Agentic AI (dokumen pemerintah/industri) | Prinsip governance tingkat tinggi untuk agentic AI                                                                  | Prinsip kualitatif (tidak computable)                       | Bersifat prinsip/pedoman, tidak machine-readable, tidak ada model keputusan                                                      |
| S11    | Towards Agentic AI Governance: A Preliminary Assessment (2026), arXiv, preprint            | Asesmen awal kesenjangan governance pada agentic AI                                                                 | Kualitatif                                                  | Bersifat gap-identification, bukan artefak model yang dapat dievaluasi                                                           |

Tabel 4. Ekstraksi data studi Tema B.

## 4.3 Tema C, Arsitektur Referensi untuk Agentic AI Enterprise

Empat studi (S12-S15) mengusulkan arsitektur atau pola arsitektural untuk sistem multi-agent enterprise. Seluruhnya bersifat deskriptif-konseptual; tidak satu pun menyertakan model keputusan formal yang dapat dievaluasi secara kuantitatif.

| **ID** | **Studi**                                                                                                           | **Fokus & Kontribusi**                                                             | **Objective/Kriteria**   | **Gap Relevan terhadap Riset Peneliti**                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| S12    | The Orchestration of Multi-Agent Systems: Architectures, Protocols, and Enterprise Adoption (2026), arXiv, preprint | Tinjauan arsitektur, protokol, dan pola adopsi enterprise untuk multi-agent system | Deskriptif arsitektural  | Tidak ada model keputusan formal; governance dibahas konseptual saja                    |
| S13    | Context Engineering: From Prompts to Corporate Multi-Agent Architecture (2026), arXiv, preprint                     | Pola arsitektur context engineering untuk multi-agent di korporasi                 | Deskriptif arsitektural  | Fokus context/prompt management, bukan lapisan decision/policy                          |
| S14    | Multi-Agent Architecture for Enterprise AI Orchestration, Eudoxus Press, venue belum terverifikasi                  | Usulan arsitektur orkestrasi enterprise                                            | Deskriptif               | Reputasi venue belum terverifikasi; perlu ditinjau ulang sebelum dijadikan sumber utama |
| S15    | Infrastructure for the Agentic Web: Gap Analysis (2026), arXiv, preprint                                            | Analisis gap infrastruktur untuk "agentic web" dari platform Agentverse            | Deskriptif infrastruktur | Skala web terbuka, bukan konteks enterprise governance/policy                           |

Tabel 5. Ekstraksi data studi Tema C.

## 4.4 Tema D, Evaluasi dan Benchmark Orkestrasi Agent

Tiga studi (S16-S18) menawarkan metode evaluasi/benchmark untuk sistem multi-agent. S18 relevan karena menggunakan basis pengetahuan kebijakan (Enterprise Contract Knowledge Base), tetapi kebijakan tersebut tidak diformalkan sebagai constraint eksplisit dalam proses keputusan.

| **ID** | **Studi**                                                                        | **Fokus & Kontribusi**                                                                                     | **Objective/Kriteria**              | **Gap Relevan terhadap Riset Peneliti**                                                                        |
| ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| S16    | Multi-Agent LLM Orchestration for Incident Response (2025), arXiv, preprint      | Framework kontainerized untuk orkestrasi multi-agent pada incident response                                | Kualitas keputusan, determinisme    | Domain sempit (incident response); tidak ada dimensi kebijakan organisasi/biaya                                |
| S17    | DecisionBench (2026), arXiv, preprint                                            | Benchmark delegasi/keputusan pada workflow agentic jangka panjang; multi-axis: kualitas, cost USD, latency | Quality, cost, latency              | Benchmark evaluasi, bukan model keputusan; tidak ada dimensi compliance/policy                                 |
| S18    | Multi-Agent Orchestration for Contract Review (2025), ACM, prosiding peer-review | Controller + Risk Agents untuk review kontrak, grounded pada Enterprise Contract Knowledge Base            | Risk (legal, commercial, technical) | Knowledge base berisi policy tetapi tidak diformalkan sebagai constraint eksplisit dalam model multi-objective |

Tabel 6. Ekstraksi data studi Tema D.

## 4.5 Tema E, MCDM Klasik untuk Seleksi Layanan Cloud/IT

Empat studi (S19-S22) menunjukkan bahwa AHP, TOPSIS, dan variasi hybrid/fuzzy-nya sudah matang digunakan bertahun-tahun untuk seleksi layanan cloud dan alokasi sumber daya IT. Ini memberi landasan teoretis kuat bagi MODM, sekaligus mengonfirmasi bahwa adaptasi formalisme ini ke konteks AI agent orchestration dengan kebijakan enterprise sebagai constraint belum banyak dieksplorasi.

| **ID** | **Studi**                                                                                                        | **Fokus & Kontribusi**                                                | **Objective/Kriteria**           | **Gap Relevan terhadap Riset Peneliti**                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| S19    | A Survey on MCDM Methods for Evaluating Cloud Computing Services, jurnal/prosiding                               | Survei metode MCDM (AHP, TOPSIS, dll.) untuk evaluasi layanan cloud   | Cost, performance, security, QoS | Domain cloud service selection klasik; belum menyentuh AI agent/LLM orchestration atau policy organisasi machine-readable |
| S20    | Adaptive Multi-Level Cloud Service Selection AHP-TOPSIS (2025), Applied Sciences (MDPI), jurnal peer-review      | Framework AHP-TOPSIS multi-level dengan bobot QoS dinamis multi-stage | QoS, cost, performance           | Bobot dinamis berbasis feedback pengguna, bukan kebijakan formal terstruktur; domain cloud, bukan AI agent                |
| S21    | A Novel Framework for Cloud Service Evaluation, Hybrid MCDM, Arabian J. Sci. Eng. (Springer), jurnal peer-review | Framework hybrid MCDM untuk evaluasi/seleksi layanan cloud            | Cost, QoS, security              | Fondasi teori kuat, tetapi domain berbeda dari AI agent orchestration                                                     |
| S22    | Prioritizing Cloud Service Selection, Fuzzy MCDM (2017), J. Supercomputing (Springer), jurnal peer-review        | Integrasi MCDM pada lingkungan fuzzy untuk seleksi layanan cloud      | Cost, QoS, uncertainty           | Menunjukkan MCDM+fuzzy sudah matang di domain cloud; belum diadaptasi ke governance AI agent                              |

Tabel 7. Ekstraksi data studi Tema E.

## 4.6 Tema F, Constrained Multi-Objective Optimization (Landasan Teori Hard/Soft Constraint)

Dua studi (S23-S24), keduanya jurnal peer-review bereputasi (IEEE Transactions on Evolutionary Computation dan Springer IJCAS), memberikan landasan matematis untuk membedakan constraint pada ruang keputusan (hard, non-negotiable) dari constraint/objective pada ruang tujuan (soft, dapat dioptimasi). Landasan ini secara langsung relevan untuk merancang struktur dua-tahap MODM yang telah didiskusikan: penyaringan berbasis hard constraint dari EPM, diikuti optimasi multi-objective pada opsi yang tersisa.

| **ID** | **Studi**                                                                                                                          | **Fokus & Kontribusi**                                                               | **Objective/Kriteria** | **Gap Relevan terhadap Riset Peneliti**                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| S23    | Handling Constrained Multiobjective Optimization Problems (2019), IEEE Trans. Evolutionary Computation, jurnal IEEE peer-review    | Teori penanganan constraint pada ruang keputusan DAN ruang objective secara simultan | N/A (teori umum)       | Fondasi matematis kuat untuk hard/soft constraint; belum pernah diterapkan ke konteks AI agent orchestration/enterprise policy |
| S24    | A Generalized Framework for Multi-objective-based Constraint Handling, Int. J. Control Autom. Syst. (Springer), jurnal peer-review | Kerangka umum penanganan constraint via pendekatan multi-objective                   | N/A (teori umum)       | Landasan teori constrained optimization yang relevan untuk struktur MODM dua-tahap                                             |

Tabel 8. Ekstraksi data studi Tema F.

# **5\. Analisis Gap Lintas-Tema**

Sintesis lintas enam tema menghasilkan tiga observasi utama yang secara langsung memvalidasi dan mempertajam posisi riset EPM + MODM:

- Pertama, riset routing/model-selection (Tema A) sudah menggunakan MCDM dan bahkan sudah dievaluasi empiris pada konteks enterprise (S1), tetapi memperlakukan seluruh kriteria sebagai compensatory, tidak ada studi yang secara eksplisit memisahkan kebijakan yang bersifat mutlak (misalnya aturan kepatuhan/privasi) dari preferensi yang dapat dikompromikan (misalnya efisiensi biaya).
- Kedua, riset governance dan policy-as-code (Tema B) sudah menghasilkan representasi kebijakan yang machine-readable dan dapat ditegakkan (S7, S9), atau kerangka evaluasi kesiapan (S8), tetapi tidak satupun menghubungkan representasi tersebut ke sebuah mesin keputusan multi-objective yang beroperasi saat runtime untuk memilih model, tool, atau menentukan kebutuhan human-approval.
- Ketiga, arsitektur referensi (Tema C) mendeskripsikan lapisan governance dan observability secara konseptual, namun tidak satupun mengintegrasikan model keputusan formal yang dapat diuji dan dibandingkan secara kuantitatif dengan baseline lain, sementara landasan teori constrained multi-objective optimization (Tema F) yang dapat mengisi kekosongan struktural ini sejatinya sudah matang di bidang lain (rekayasa/evolutionary computation) namun belum diadaptasi ke konteks AI agent orchestration.

Ketiga observasi ini secara koheren mendukung posisi riset yang telah dirumuskan sebelumnya: sebuah Policy-Constrained Multi-Objective Decision Model yang (a) menggunakan Enterprise Policy Model formal sebagai sumber hard constraint dan soft preference secara eksplisit terpisah, (b) menghasilkan keputusan orkestrasi yang lebih luas dari sekadar pemilihan model, mencakup pemilihan tool dan penentuan kebutuhan human-approval, dan (c) dibangun di atas landasan teori constrained multi-objective optimization yang sudah mapan namun belum diterapkan pada domain ini. Tidak satu pun dari 24 studi primer yang ditinjau mengklaim kombinasi ketiga elemen ini sekaligus.

# **6\. Threats to Validity (Keterbatasan)**

- Recency/availability bias: topik agentic AI governance sangat baru (mayoritas studi terbit 2025-2026), sehingga representasi topik ini dalam literatur belum stabil dan berpotensi berubah cepat.
- Tidak dilakukan snowballing sitasi (backward/forward) secara sistematis; hanya pencarian berbasis kata kunci pada 14 query.
- Cakupan bahasa dibatasi pada Inggris; literatur berbahasa Indonesia atau bahasa lain tidak tercakup.
- Beberapa studi (khususnya S7, S8, S9, S14) adalah preprint/working paper/venue belum terverifikasi, klaim di dalamnya belum divalidasi melalui peer-review dan perlu dikutip dengan kehati-hatian eksplisit di naskah tesis.

# **7\. Kesimpulan**

SLR ini mengonfirmasi bahwa arah riset "Policy-Constrained Multi-Objective Decision Model untuk orkestrasi AI agent enterprise" menempati celah yang belum terisi oleh 24 studi primer yang ditinjau, sekaligus dapat dibangun di atas fondasi teori yang sudah matang (MCDM klasik dari Tema E, constrained multi-objective optimization dari Tema F) dan berdialog langsung dengan studi paling dekat secara konseptual (S1 Nowak 2026, S7 Jackson 2025, S8 CAGE-1, S9 AI FinOps) sebagai related work utama yang wajib dibahas eksplisit di Bab 2 tesis.

Langkah berikutnya yang direkomendasikan: (1) validasi ulang cakupan pencarian ini melalui akses database institusional ITB, (2) formulasi research question tesis berdasarkan gap di Bagian 5, dan (3) perancangan skema awal EPM berdasarkan landasan Tema B dan F.

# **7a. Addendum: Studi Tambahan Pasca-SLR**

Satu studi tambahan diidentifikasi pada 2026-08-08, di luar protokol pencarian 14-query pada Bagian 2.2 (yaitu bukan bagian dari 24 studi primer yang disintesis pada Bagian 3-5), saat melakukan perbandingan related work untuk prototipe MADE. Dicatat di sini secara transparan sebagai temuan pasca-review, bukan disisipkan diam-diam ke penghitungan 24 studi primer, agar keterlacakan metodologi SLR asli tetap utuh.

| **ID** | **Studi** | **Fokus & Kontribusi** | **Objective/Kriteria** | **Gap Relevan terhadap Riset Peneliti** |
| --- | --- | --- | --- | --- |
| S25 | Bai, R., et al. OmniRouter: Budget and Performance Controllable Multi-LLM Routing (2026), arXiv:2502.20576, preprint | Routing multi-LLM berbasis constrained optimization: tahap prediksi (kapabilitas & biaya model) diikuti optimizer (Lagrangian dual decomposition) yang menyeimbangkan latency vs quality threshold vs kapasitas model, diklaim +6.30% akurasi dan -10.15% biaya dibanding baseline router | Cost, quality threshold, latency, kapasitas model (constrained multi-LLM routing) | Constraint yang dipakai bersifat teknis (threshold performa, kapasitas), bukan kebijakan organisasi; tidak ada pemisahan hard constraint non-negotiable (compliance/privasi/approval) dari preferensi optimizable; hanya mencakup pemilihan model, tidak tool/human-approval |

Tabel 9. Ekstraksi data studi tambahan S25.

**Relevansi terhadap Analisis Gap (Bagian 5):** S25 memperkuat observasi pertama pada Bagian 5 dengan bukti paling mutakhir. Meski judul dan metodenya eksplisit menyebut "constrained" dan "budget/performance controllable" — secara sekilas tampak tumpang tindih dengan pendekatan constrained multi-objective yang diusulkan peneliti — constraint di S25 tetap seluruhnya berada dalam ruang teknis (ambang performa, kapasitas model), sejalan dengan pola lima studi Tema A lainnya (S2-S6). Tidak ada representasi kebijakan organisasi (compliance, privasi, human-approval) sebagai hard constraint terpisah dari preferensi optimizable. S25 karenanya menjadi bukti tambahan bahwa riset routing LLM terbaru pun (2026) belum menjangkau dimensi governance yang menjadi kontribusi EPM+MODM.

# **Daftar Pustaka**

\[S1\] A Multi-Criteria Decision Framework for Enterprise LLM Routing (2026). Jurnal (MDPI Information).

\[S2\] Bayesian Orchestration of Multi-LLM Agents (2026). Preprint (arXiv).

\[S3\] Multi-Agent Routing as Set-Valued Prediction (2026). Preprint (arXiv).

\[S4\] Causal LLM Routing: Regret Minimization from Observational Data (2025). Preprint (arXiv).

\[S5\] Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey (2026). Preprint (arXiv).

\[S6\] One Head, Many Models: Cross-Attention Routing for Cost-Aware LLM Selection (2025). Preprint (arXiv).

\[S7\] Governing Autonomous AI Agents with Policy-as-Code (2025). Working paper (SSRN).

\[S8\] CAGE-1: Control, Assurance, and Governance Evaluation for Enterprise Agentic AI (2026). Preprint (arXiv).

\[S9\] AI FinOps: A Governance Framework for Cost-Efficient Generative AI (2026). Working paper (SSRN).

\[S10\] Model AI Governance Framework for Agentic AI (2026). Dokumen pemerintah (IMDA Singapura).

\[S11\] Towards Agentic AI Governance: A Preliminary Assessment (2026). Preprint (arXiv).

\[S12\] The Orchestration of Multi-Agent Systems: Architectures, Protocols, Enterprise Adoption (2026). Preprint (arXiv).

\[S13\] Context Engineering: From Prompts to Corporate Multi-Agent Architecture (2026). Preprint (arXiv).

\[S14\] Multi-Agent Architecture for Enterprise AI Orchestration (2026). Venue belum terverifikasi.

\[S15\] Infrastructure for the Agentic Web: Gap Analysis and Architecture (2026). Preprint (arXiv).

\[S16\] Multi-Agent LLM Orchestration for Incident Response (2025). Preprint (arXiv).

\[S17\] DecisionBench: A Benchmark for Emergent Delegation in Agentic Workflows (2026). Preprint (arXiv).

\[S18\] Multi-Agent Orchestration of Local LLMs for Contract Review (2025). Prosiding (ACM).

\[S19\] A Survey on MCDM Methods for Evaluating Cloud Computing Services (2016). Jurnal/prosiding.

\[S20\] Adaptive Multi-Level Cloud Service Selection Using AHP-TOPSIS (2025). Jurnal (MDPI Applied Sciences).

\[S21\] A Novel Framework for Cloud Service Evaluation Using Hybrid MCDM (2018). Jurnal (Springer).

\[S22\] Prioritizing Cloud Service Selection Using Integrated MCDM under Fuzzy Environment (2017). Jurnal (Springer).

\[S23\] Handling Constrained Multiobjective Optimization Problems (2019). Jurnal (IEEE Trans. Evolutionary Computation).

\[S24\] A Generalized Framework for Multi-objective-based Constraint Handling Technique (2024). Jurnal (Springer).

\[S25\] Bai, R., et al. (2026). OmniRouter: Budget and Performance Controllable Multi-LLM Routing. arXiv:2502.20576. (Studi tambahan pasca-SLR, lihat Bagian 7a — di luar 24 studi primer hasil protokol pencarian asli.)