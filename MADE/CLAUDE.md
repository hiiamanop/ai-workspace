# Obsidian mirroring

Vault Obsidian terhubung via MCP server `obsidian` (lihat `claude mcp list`).
Folder proyek ini di vault: `Projects/MODE/`.

Setiap kali membuat atau memperbarui salah satu dari berikut, tulis juga salinannya ke `Projects/MODE/` di vault Obsidian (pakai tool MCP `obsidian`, path `vault/Projects/MODE/<nama-file>.md`):

- Memory baru/diperbarui (dari `~/.claude/projects/.../memory/`)
- Dokumen (`docs/`, catatan desain, dsb.)
- Plan (hasil `writing-plans` atau `EnterPlanMode`)

Jangan tulis draft/scratch sementara — hanya versi final yang sudah disimpan di repo atau memory. Kalau koneksi MCP `obsidian` gagal (terputus/timeout), lanjutkan kerjaan seperti biasa dan beri tahu user sekali, jangan retry berulang.

Setelah menulis note, selalu beri user deep-link `obsidian://open?vault=Obsidian%20Vault&file=<path-terenkode>` supaya bisa langsung dibuka di Obsidian. Nama vault: `Obsidian Vault`.
