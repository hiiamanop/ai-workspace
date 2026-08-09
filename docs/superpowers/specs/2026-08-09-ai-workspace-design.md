# Design: AI Workspace (Open WebUI-like, dengan editor dokumen kolaboratif)

Status: draft, menunggu persetujuan user
Proyek terpisah dari tesis MADE — repo sendiri di `/home/naufa/workspace/ai-workspace`.

## 1. Visi

Workspace AI self-hosted, free-tier, mirip Open WebUI, dengan dua pembeda utama:

1. Bisa membuat/mengedit dokumen Word/Sheet/Slide kolaboratif secara real-time langsung dari chat (bukan cuma ngobrol teks).
2. Pemilihan model AI dan tool per request diputuskan oleh **MADE** (Multi-Objective Agent Decision Engine, dari proyek tesis terpisah), bukan hardcode atau pilihan manual user.

## 2. Arsitektur & Komponen

| Komponen | Peran | Teknologi |
|---|---|---|
| Chat/workspace shell | UI utama: chat, daftar tools, akses dokumen | Node/TypeScript (custom) |
| MADE | Menentukan model & tool yang boleh dipakai per task, berdasarkan kebijakan (EPM) dan optimasi multi-objektif (MODM) | Python/FastAPI, dipanggil sebagai HTTP service terpisah (`POST /decide`) |
| MCP tools | Kemampuan eksternal yang dipanggil AI | MCP servers (mulai dari SearXNG + Scrapling untuk web search/scraping) |
| Univer | Editor Word/Sheet/Slide, real-time collaborative, dipanggil sebagai tool dari chat maupun langsung dibuka user | Web framework TypeScript ([dream-num/univer](https://github.com/dream-num/univer)), plugin custom untuk AI sidebar |
| Nextcloud | Penyimpanan permanen dokumen/file | Storage backend, diakses via WebDAV |

MADE tetap berjalan sebagai service Python terpisah (repo `MODE`) — proyek ini memanggilnya lewat HTTP, tidak menyalin/menulis ulang logic-nya.

## 3. Dua Permukaan Chat, Satu Backend

- **Chat utama (workspace)**: ruang chat umum, konteks bebas, semua tools tersedia. Model interaksi: user chat → AI panggil tool bila perlu (termasuk "buat dokumen baru" yang membuka instance Univer).
- **Sidebar AI di dalam Univer**: panel kecil saat user membuka dokumen tertentu, memanggil backend chat yang **sama persis**, tapi request-nya menyertakan `document_context` (isi/selection dokumen aktif) sehingga AI langsung tahu konteks tanpa dijelaskan ulang. Bukan sistem terpisah — hanya permukaan UI tambahan + field context tambahan di payload.

Dokumen TIDAK dirender di dalam jendela chat utama (beda dari pola "artifact" ala Claude/ChatGPT) — selalu di panel/halaman Univer sendiri, karena butuh real-time collaboration yang tidak masuk akal dilakukan di dalam bubble chat.

## 4. Alur End-to-End

1. **User kirim pesan di chat** → shell kirim ke `MADE POST /decide` dengan konteks task → MADE balas model mana yang dipakai (mempertimbangkan biaya/kualitas/latensi/risiko, dan bobot lebih ketat otomatis untuk data classification confidential/restricted, mengikuti fitur `epm-critical.yaml` yang sudah ada di MADE).
2. **AI butuh info eksternal** → panggil tool `web_search` (SearXNG via MCP) → bila perlu isi halaman penuh, panggil `Scrapling` (juga via MCP) → hasil dirangkum ke user. MADE juga menentukan tool mana yang boleh dipanggil untuk task tersebut, bukan hanya model.
3. **User minta dokumen dibuat** ("buatkan laporan ini jadi Word") → AI panggil tool Univer → instance editor baru terbuka di panel terpisah berisi draft.
4. **Kolaborasi & edit manual** → user (atau kolaborator lain, multi-user sejak awal) mengedit dokumen langsung di Univer secara real-time, dengan atau tanpa AI.
5. **Auto-save ke Nextcloud** → setiap perubahan di Univer disinkronkan ke Nextcloud via WebDAV, dokumen permanen dan bisa diakses/di-share kapan saja.
6. **Edit terbantu AI di dalam dokumen** → user select teks di Univer → ketik instruksi di sidebar AI → request ke backend yang sama (dengan `document_context`) → AI edit langsung di tempat.

## 5. Milestone (bertahap, satu sub-proyek per tahap)

1. **Chat inti** — UI chat + backend Node/TS yang memanggil MADE untuk pilih model, chat berjalan dengan model tsb. Belum ada tools/dokumen/storage.
2. **+ MCP tools** — sambungkan SearXNG (self-hosted) via MCP server yang sudah ada (mis. `ihor-sokoliuk/mcp-searxng`), tambah Scrapling untuk scraping halaman penuh (MCP integration sudah tersedia di repo Scrapling sendiri).
3. **+ Univer sebagai tool** — AI bisa buat/edit dokumen dari chat, dirender di panel terpisah; termasuk sidebar AI di dalam Univer (§3).
4. **+ Nextcloud storage** — dokumen dari milestone 3 disimpan permanen, bukan sementara.

## 6. Di Luar Cakupan Awal

Eksplisit belum masuk 4 milestone di atas, dicatat supaya batasnya jelas:

- Image generation, code interpreter/terminal, RAG/knowledge base atas dokumen upload — kandidat MCP tools tambahan di masa depan, bukan bagian milestone 1-4.
- Auth/multi-user penuh (role, permission per organisasi) — belum dirancang detail, diasumsikan single-user dulu untuk milestone 1-4, multi-user baru relevan penuh begitu Nextcloud+Univer terhubung (milestone 3-4 sudah punya fondasi multi-user dari kedua tools tsb, tapi lapisan permission/organisasi di shell sendiri belum dirancang).
- Mobile/native app — web-based dulu.
- Isolasi/hardening keamanan MCP tools (mis. sandboxing eksekusi kode) — belum relevan karena code interpreter belum masuk cakupan awal.

## 7. Keputusan Desain & Alasannya

- **GenOffice (desktop Electron) ditolak sebagai app layer**, walau AI-native editingnya menarik — mismatch dengan kebutuhan web-based + real-time collaboration. Univer dipilih karena web-native, sudah punya real-time collab, dan justru menjadi basis mesin spreadsheet GenOffice sendiri — jadi tetap mewarisi filosofi yang sama tanpa mismatch arsitektur.
- **Nextcloud dipakai murni sebagai storage**, bukan office suite bawaannya (Collabora/OnlyOffice) — karena Univer sudah mengisi peran itu dengan lebih AI-native.
- **Node/TypeScript untuk shell**, karena satu bahasa dengan Univer (memudahkan integrasi plugin), sementara MADE tetap Python tapi sudah berbentuk service HTTP sehingga beda bahasa tidak masalah.
- **SearXNG + Scrapling untuk tool pertama**: keduanya open-source lisensi permisif (MIT/BSD-3, aman untuk produk free-tier), dan keduanya sudah punya integrasi MCP siap pakai — tidak perlu membangun MCP wrapper dari nol.
- **Proyek ini sengaja dipisah dari repo/histori tesis MADE** — bukan bagian dari deliverable akademik, dan tidak boleh menambah risiko jadwal tesis. Integrasi ke MADE murni lewat HTTP API, satu arah (proyek ini adalah konsumen API MADE, MADE tidak tahu proyek ini ada).

## 8. Testing (garis besar, akan dirinci per milestone di implementation plan)

- Milestone 1: test bahwa shell memanggil `MADE /decide` dengan payload benar dan meneruskan pilihan model ke provider yang tepat.
- Milestone 2: test tool-calling loop (AI memilih memanggil `web_search`, hasil terformat balik ke konteks chat) dengan MCP server di-mock.
- Milestone 3: test bahwa perintah "buat dokumen" menghasilkan instance Univer baru dengan konten yang sesuai; test payload `document_context` terkirim benar dari sidebar.
- Milestone 4: test round-trip save/load dokumen ke Nextcloud via WebDAV.
