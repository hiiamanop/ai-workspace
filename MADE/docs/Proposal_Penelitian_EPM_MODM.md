Proposal Penelitian Tesis Magister

## A Policy-Constrained Multi-Objective Decision Model for AI Agent Orchestration in the Enterprise

_(Model Keputusan Multi-Objective Berbasis Kebijakan untuk Orkestrasi AI Agent di Lingkungan Enterprise)_

**Diajukan oleh: Ahmad Naufal Muzakki**

_Program Studi Magister Sistem dan Teknologi Informasi, Institut Teknologi Bandung_

_Tanggal: 6 Agustus 2026_

_Catatan: NIM dan format sampul mengikuti template resmi proposal tesis ITB - mohon disesuaikan sebelum diserahkan ke program studi._

# 1\. Latar Belakang

Adopsi agentic AI di lingkungan enterprise berkembang sangat cepat. Gartner mencatat pertumbuhan permintaan informasi (inquiries) perusahaan terkait multi-agent system sebesar 1.445% antara Q1 2024 dan Q2 2025, dan survei Google Cloud terhadap 3.466 pemimpin enterprise di 24 negara menemukan 52% eksekutif sudah memiliki deployment agent aktif. Namun pertumbuhan ini diikuti oleh krisis governance biaya yang terdokumentasi luas: Gartner memprediksi lebih dari 40% proyek agentic AI akan dibatalkan pada 2027 karena biaya yang membengkak dan kontrol yang tidak memadai; terdapat kasus konkret satu enterprise menghabiskan 500 juta dolar AS dalam sebulan untuk layanan AI tanpa disadari hingga invoice datang; dan riset Omdia menemukan 59% enterprise telah menghentikan atau menunda deployment agentic AI karena biaya observability yang tak terkendali. Sumber industri secara eksplisit mencatat bahwa di sebagian besar perusahaan, tidak ada pihak yang memiliki kepemilikan (ownership) yang jelas atas governance biaya AI agent di seluruh organisasi.

Akar masalahnya bersifat struktural: kerangka kerja AI agent yang ada saat ini (LangGraph, CrewAI, AutoGen, Semantic Kernel) dirancang untuk mengoptimasi penyelesaian tugas (task completion), bukan untuk menyeimbangkan tujuan organisasi seperti biaya, kepatuhan, keamanan, privasi, dan kebutuhan persetujuan manusia. Dengan kata lain, AI agent saat ini bersifat task-aware, tetapi tidak organization-aware.

Tinjauan literatur sistematis yang telah dilakukan (lihat dokumen SLR terlampir, mencakup 24 studi primer dari enam sub-tema) mengonfirmasi tiga celah riset yang saling berkaitan. Pertama, riset routing/model-selection berbasis MCDM (paling relevan: Nowak, 2026, dipublikasikan di jurnal Information/MDPI) sudah mempertimbangkan banyak kriteria termasuk risiko bisnis, tetapi memperlakukan seluruh kriteria sebagai compensatory - tidak ada pemisahan eksplisit antara kebijakan yang bersifat mutlak (non-negotiable) dan preferensi yang dapat dikompromikan. Kedua, riset governance dan policy-as-code (Jackson, 2025; Sure/CAGE-1, 2026; Lingamgunta/AI FinOps, 2026) menghasilkan representasi kebijakan yang machine-readable dan dapat ditegakkan, tetapi berfungsi sebagai enforcement atau accounting, bukan sebagai input formal ke mesin pengambilan keputusan multi-objective. Ketiga, arsitektur referensi untuk agentic AI enterprise bersifat deskriptif-konseptual tanpa model keputusan formal yang dapat dievaluasi secara kuantitatif.

Penelitian ini diarahkan untuk mengisi celah tersebut dengan merancang model keputusan yang secara formal menghubungkan representasi kebijakan enterprise dengan proses pengambilan keputusan orkestrasi AI agent - sebuah kontribusi yang memposisikan diri pada persimpangan antara riset optimasi teknis (MCDM/multi-objective optimization) dan riset governance AI (policy-as-code), dua arus riset yang selama ini berjalan terpisah.

# 2\. Rumusan Masalah

RQ1. Bagaimana kebijakan enterprise (kepatuhan, keamanan, privasi, biaya, ambang persetujuan manusia) dapat direpresentasikan secara formal dan machine-readable, sedemikian rupa sehingga dapat membedakan constraint yang bersifat mutlak (non-negotiable) dari preferensi yang dapat dioptimasi (trade-off-able)?

RQ2. Bagaimana merancang model keputusan multi-objective yang menggunakan representasi kebijakan tersebut untuk menentukan pemilihan model AI, pemilihan tool, dan kebutuhan human-approval dalam orkestrasi AI agent enterprise?

RQ3. Sejauh mana model yang diusulkan (EPM + MODM) mampu meningkatkan kepatuhan kebijakan (policy compliance) dibandingkan pendekatan yang ada saat ini - MCDM compensatory murni (mis. AHP-SAW) atau framework orkestrasi tanpa policy-awareness - tanpa mengorbankan performa secara signifikan pada dimensi biaya, kualitas, dan latensi?

# 3\. Tujuan Penelitian

1\. Merancang dan memformalkan Enterprise Policy Model (EPM): skema representasi kebijakan enterprise yang machine-readable, membedakan hard constraint dan soft preference secara eksplisit.

2\. Merancang Multi-Objective Decision Model (MODM) dua tahap yang mengonsumsi EPM untuk menghasilkan keputusan orkestrasi AI agent, mencakup pemilihan model AI, pemilihan tool, dan penentuan kebutuhan human-approval.

3\. Mengimplementasikan prototipe (proof-of-concept) dari EPM dan MODM sebagai bukti keterlaksanaan (MADE - Multi-Objective Agent Decision Engine).

4\. Mengevaluasi efektivitas EPM+MODM secara empiris melalui eksperimen terkontrol dibandingkan pendekatan baseline yang ada.

# 4\. Manfaat Penelitian

## 4.1 Manfaat Teoretis

Penelitian ini berkontribusi pada model keputusan formal yang menjembatani dua arus riset yang selama ini berjalan terpisah - riset MCDM/optimasi teknis untuk routing AI, dan riset governance/policy-as-code untuk AI agent - sebagaimana ditunjukkan oleh analisis gap pada tinjauan literatur sistematis (Bagian 5 dan Lampiran SLR). Kontribusi utamanya adalah formalisasi constrained multi-objective decision model yang membedakan constraint non-negotiable dari preferensi optimizable dalam konteks orkestrasi AI agent - sesuatu yang belum diklaim oleh studi manapun yang ditinjau.

## 4.2 Manfaat Praktis

Bagi enterprise, model ini menawarkan kerangka kerja yang dapat diadopsi untuk mengendalikan risiko dan biaya AI agent secara terstruktur dan machine-readable, tanpa mengorbankan kelincahan operasional - menjawab langsung persoalan cost governance dan accountability gap yang menjadi motivasi awal penelitian ini.

# 5\. Ruang Lingkup dan Batasan Penelitian

- Cakupan keputusan MODM dibatasi pada tiga jenis: pemilihan model AI, pemilihan tool, dan keputusan kebutuhan human-approval. Orkestrasi workflow penuh lintas banyak agent (multi-step business process orchestration) berada di luar cakupan.
- EPM dikonstruksi secara manual/semi-terstruktur untuk kebutuhan skenario eksperimen. Ekstraksi otomatis kebijakan dari dokumen prosa (SOP, kontrak, regulasi) tidak menjadi bagian dari penelitian ini dan diusulkan sebagai kerja lanjutan (future work).
- Evaluasi menggunakan skenario/dataset yang dikonstruksi peneliti (terinspirasi metodologi Nowak, 2026), bukan data produksi enterprise riil, mengingat keterbatasan akses data organisasi pada skala penelitian magister.
- Enterprise AI Reference Architecture (EAIRA) disajikan sebagai peta konteks yang menunjukkan posisi EPM dan MODM dalam sistem enterprise, dan tidak dievaluasi secara mendalam sebagai artefak independen.
- Prototipe (MADE) berfungsi sebagai bukti keterlaksanaan (proof-of-concept), bukan sebagai produk siap produksi; integrasi dibatasi pada sejumlah kecil model AI dan tool representatif untuk kebutuhan eksperimen.

# 6\. Tinjauan Pustaka

Tinjauan pustaka lengkap disusun sebagai Systematic Literature Review (SLR) tersendiri mengikuti metode Kitchenham & Charters (2007), mencakup 24 studi primer yang terbagi dalam enam sub-tema: (A) model MCDM/multi-objective untuk routing LLM dan agent, (B) representasi kebijakan dan governance untuk AI, (C) arsitektur referensi untuk agentic AI enterprise, (D) evaluasi dan benchmark orkestrasi agent, (E) MCDM klasik untuk seleksi layanan cloud/IT sebagai landasan teori, dan (F) constrained multi-objective optimization sebagai landasan teori hard/soft constraint. Dokumen SLR (file terpisah: SLR_Kitchenham_EPM_MODM.docx) menjadi lampiran wajib dari proposal ini.

Tiga studi paling relevan yang menjadi rujukan pembanding utama: Nowak (2026) - framework MCDM (AHP+SAW) untuk routing LLM enterprise, dievaluasi empiris pada 500 prompt bisnis, menjadi baseline eksperimen utama; Jackson (2025) - arsitektur policy-as-code multi-layer untuk governance agent otonom, menjadi rujukan desain EPM; dan hasil sintesis Tema F (constrained multi-objective optimization, IEEE Trans. Evolutionary Computation) yang menjadi landasan matematis struktur dua-tahap MODM.

Analisis gap lintas-tema pada SLR menyimpulkan bahwa tidak satu pun dari 24 studi primer mengklaim kombinasi tiga elemen yang diusulkan penelitian ini: (a) EPM formal yang memisahkan hard constraint dari soft preference secara eksplisit, (b) cakupan keputusan yang lebih luas dari sekadar pemilihan model (mencakup tool dan human-approval), dan (c) landasan teori constrained multi-objective optimization yang diadaptasi khusus untuk konteks orkestrasi AI agent enterprise.

Temuan pasca-SLR (Bai et al., OmniRouter, arXiv:2502.20576, 2026 — lihat Addendum SLR Bagian 7a) memperkuat kesimpulan ini dengan bukti paling mutakhir: meski OmniRouter secara eksplisit memakai kerangka *constrained optimization* untuk routing multi-LLM, constraint-nya tetap murni teknis (ambang performa, kapasitas model, biaya) tanpa representasi kebijakan organisasi (compliance, privasi, human-approval) sebagai hard constraint yang terpisah dari preferensi optimizable — mengonfirmasi bahwa riset routing LLM terkini pun belum menjangkau dimensi governance yang menjadi kontribusi EPM+MODM.

# 7\. Metodologi Penelitian

Penelitian ini menggunakan Design Science Research Methodology (DSRM), mengikuti enam tahap sebagai berikut.

1\. Problem Identification & Motivation - telah dilakukan melalui observasi fenomena cost governance crisis pada agentic AI enterprise, didukung data industri (Gartner, Omdia, Forbes) dan divalidasi melalui Systematic Literature Review terhadap 24 studi primer.

2\. Define Objectives of Solution - dirumuskan sebagai tiga research question dan empat tujuan penelitian pada Bagian 2 dan 3.

3\. Design & Development - memformalkan skema EPM (extend formalisme policy-as-code seperti OPA/Rego) dan merumuskan MODM sebagai model dua tahap: penyaringan berbasis hard constraint dari EPM, diikuti optimasi multi-objective (mempertimbangkan teknik seperti weighted-sum, TOPSIS, atau Pareto-based) pada opsi yang tersisa.

4\. Demonstration - mengimplementasikan prototipe MADE (Multi-Objective Agent Decision Engine) yang mengintegrasikan EPM dan MODM dengan API model AI riil serta sejumlah tool representatif.

5\. Evaluation - menguji MADE pada dataset skenario task dan kebijakan yang dikonstruksi (terinspirasi metodologi Nowak, 2026), dibandingkan dengan baseline: (a) pendekatan AHP-SAW compensatory murni, (b) strategi always-strong/always-cheap, dan (c) framework orkestrasi existing tanpa policy-awareness (mis. LangGraph/CrewAI dasar). Metrik evaluasi mencakup policy violation rate, biaya (cost), kualitas/response sufficiency, dan latensi.

6\. Communication - hasil dikomunikasikan melalui naskah tesis lengkap dan draf paper untuk submisi jurnal/konferensi.

# 8\. Rencana Kerja dan Jadwal (6 Bulan / 24 Minggu)

| **Fase**               | **Minggu** | **Aktivitas**                                                                                                                 | **Output**                             |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1\. Penajaman Masalah  | 1-2        | Validasi ulang SLR dengan akses database institusional (Scopus/IEEE Xplore/ACM DL); diskusi rumusan masalah dengan pembimbing | SLR tervalidasi, rumusan masalah final |
| 2\. Sidang Proposal    | 3-4        | Finalisasi tujuan, ruang lingkup, dan metodologi; seminar/sidang proposal                                                     | Proposal disetujui pembimbing          |
| 3\. Desain EPM         | 5-6        | Rancang skema representasi kebijakan (extend OPA/Rego); definisikan kategori hard constraint & soft preference                | Spesifikasi skema EPM v1               |
| 4\. Instance Kebijakan | 7-8        | Susun contoh kebijakan (budget, privasi, compliance, ambang human-approval) untuk skenario eksperimen                         | Set kebijakan uji tervalidasi          |
| 5\. Formulasi MODM     | 9-10       | Rumuskan model matematis dua tahap (filtering hard constraint + optimasi multi-objective); tentukan teknik optimasi           | Formulasi matematis MODM               |
| 6\. Desain Algoritma   | 11-12      | Rancang algoritma keputusan; bandingkan teknik (weighted-sum/TOPSIS/Pareto); justifikasi teoretis                             | Spesifikasi algoritma MODM             |
| 7\. Prototipe v1       | 13-14      | Implementasi decision engine EPM+MODM; integrasi API model AI (mis. GPT/Claude)                                               | Prototipe fungsional (pemilihan model) |
| 8\. Prototipe v2       | 15-16      | Tambahkan mekanisme pemilihan tool dan gate human-approval; uji fungsional end-to-end                                         | Prototipe fungsional lengkap (MADE)    |
| 9\. Dataset Eksperimen | 17         | Susun skenario task + kebijakan uji, terinspirasi metodologi Nowak (2026)                                                     | Dataset eksperimen                     |
| 10\. Eksperimen        | 18         | Jalankan MODM+EPM vs baseline (AHP-SAW, always-strong/cheap, framework existing)                                              | Data hasil eksperimen mentah           |
| 11\. Analisis Hasil    | 19-20      | Analisis metrik (policy violation rate, cost, quality, latency); uji statistik                                                | Temuan & interpretasi hasil            |
| 12\. Penulisan Hasil   | 21-22      | Tulis bab hasil dan pembahasan; revisi naskah tesis keseluruhan                                                               | Draf tesis lengkap                     |
| 13\. Draf Publikasi    | 23         | Ekstraksi draf paper jurnal/konferensi dari naskah tesis                                                                      | Draf paper                             |
| 14\. Sidang Akhir      | 24         | Persiapan dan pelaksanaan sidang tesis                                                                                        | Tesis final                            |

_Tabel 1. Rencana kerja penelitian dipetakan pada tahapan DSRM, disusun untuk timeline satu semester._

Catatan: jadwal ini bersifat ambisius untuk skala satu semester dan mengasumsikan tidak ada hambatan signifikan pada tahap formalisasi EPM/MODM (Minggu 5-12), yang secara historis menjadi tahap paling berisiko molor pada penelitian sejenis. Disarankan mendiskusikan buffer waktu dengan pembimbing, khususnya di sekitar Minggu 9-12 (formulasi MODM) dan Minggu 18-20 (eksperimen dan analisis), sebelum jadwal ini difinalisasi.

# 9\. Daftar Pustaka

\[1\] Nowak, M. (2026). A Multi-Criteria Decision Framework for Enterprise LLM Routing. Information, 17(6), 539. <https://doi.org/10.3390/info17060539>

\[2\] Jackson, F. (2025). Governing Autonomous AI Agents with Policy-as-Code: A Multi-Layer Architecture for Risk, Compliance, and Zero-Trust Control. SSRN 5820262.

\[3\] Sure, R. W. (2026). CAGE-1: Control, Assurance, and Governance Evaluation for Enterprise Agentic AI. arXiv:2607.03510.

\[4\] Lingamgunta, R. K. K. (2026). AI FinOps: A Governance Framework for Cost-Efficient and Responsible Generative AI at Enterprise Scale. SSRN 6703658.

\[5\] Kitchenham, B., & Charters, S. (2007). Guidelines for performing Systematic Literature Reviews in Software Engineering. EBSE Technical Report.

\[6\] Peffers, K., Tuunanen, T., Rothenberger, M. A., & Chatterjee, S. (2007). A Design Science Research Methodology for Information Systems Research. Journal of Management Information Systems, 24(3), 45-77.

\[7\] Referensi lengkap 24 studi primer terkait state-of-the-art dan gap riset tercantum pada Daftar Pustaka dokumen SLR_Kitchenham_EPM_MODM.docx (lampiran).

\[8\] Bai, R., et al. (2026). OmniRouter: Budget and Performance Controllable Multi-LLM Routing. arXiv:2502.20576. (Temuan pasca-SLR, lihat Addendum SLR Bagian 7a.)