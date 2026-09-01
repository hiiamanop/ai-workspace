---
name: AI orchestration patterns
 description: Riset singkat tentang praktik membangun sistem AI orchestration dari dokumentasi resmi.
date: 2026-09-01
status: investigating
tags: [ai, orchestration, agents, architecture, research]
---

# AI orchestration patterns

## Kesimpulan

Mulai dari workflow deterministik, bukan multi-agent otonom. Gunakan LLM untuk keputusan yang memang membutuhkan fleksibilitas; biarkan kode mengontrol urutan, batas percobaan, izin, timeout, dan validasi. Anthropic membedakan workflow (alur ditentukan kode) dari agent (LLM menentukan proses dan pemakaian tool), serta merekomendasikan pola sederhana dan composable.

## Pola utama

- **Sequential/pipeline:** langkah A → B → C; cocok untuk ekstraksi → validasi → output.
- **Parallel/concurrent:** beberapa subtask independen berjalan bersamaan, lalu disintesis.
- **Router/triage:** satu classifier memilih spesialis berdasarkan intent atau risiko.
- **Manager + specialists as tools:** manager tetap memiliki jawaban akhir dan memanggil spesialis sebagai kemampuan terbatas.
- **Handoff:** kontrol percakapan berpindah ke spesialis; gunakan hanya jika spesialis memang harus memiliki respons berikutnya.
- **Agent loop:** model memilih tool dan mengulang sampai selesai; pasang batas iterasi, timeout, budget, dan kondisi berhenti.

OpenAI menyarankan memilih antara handoffs dan agents-as-tools berdasarkan siapa yang memiliki respons user-facing. MCP menyediakan protokol pertukaran context/tool, tetapi tidak menentukan cara aplikasi mengorkestrasi LLM.

## Guardrails produksi

1. Definisikan kontrak input/output terstruktur untuk setiap node.
2. Validasi output model sebelum diteruskan ke node berikutnya.
3. Terapkan least privilege pada tool, approval untuk aksi destruktif, dan sanitasi input/output.
4. Batasi loop: max steps, timeout, token/cost budget, retries dengan backoff, dan circuit breaker.
5. Pisahkan state percakapan, state workflow, dan audit/event log.
6. Trace setiap keputusan: prompt/version, model, tool, latency, token/cost, error, dan hasil evaluasi; jangan log secret atau data sensitif mentah.
7. Uji dengan dataset tugas nyata, tool failure, prompt injection, timeout, context overflow, dan regresi biaya/latensi.
8. Sediakan fallback deterministic atau human approval ketika confidence rendah, policy menolak, atau tidak ada kandidat yang aman.

## Rekomendasi untuk ai-workspace

Arsitektur saat ini sudah dekat dengan pola yang tepat: MADE sebagai policy/router, chat sebagai runtime, tools dengan izin terbatas, context guard, streaming, dan fallback. Evolusi yang disarankan: tetapkan typed decision envelope untuk MADE; tambahkan workflow/run ID dan trace spans; enforce budget/step limits di server; validasi semua tool arguments/results dengan schema; dan ukur kualitas routing, biaya, latensi, serta refusal rate sebelum menambah agent otonom.

## Sumber resmi

- Anthropic, *Building effective agents*: https://www.anthropic.com/research/building-effective-agents
- OpenAI, *Orchestration and handoffs*: https://developers.openai.com/api/docs/guides/agents/orchestration
- Microsoft Azure Architecture Center, *AI Agent Orchestration Patterns*: https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns
- Model Context Protocol, *Architecture overview*: https://modelcontextprotocol.io/docs/learn/architecture
- OpenAI Agents SDK overview: https://platform.openai.com/docs/guides/agents
- Anthropic, *Tool use with Claude*: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
