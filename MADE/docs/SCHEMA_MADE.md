# Schema — MADE (Multi-Objective Agent Decision Engine)

Status: Draft v1 · Tanggal: 2026-08-08 · Terkait: `docs/ARCHITECTURE_MADE.md`

## 1. Struktur direktori EPM (policy repo, version-controlled)

```
policies/
  epm.yaml                 # manifest: soft preferences, weights, technique
  hard/
    compliance.rego
    security.rego
    privacy.rego
    cost.rego
    approval.rego           # aturan kapan human-approval wajib
    *_test.rego             # opa test per file
```

## 2. Kontrak input/output OPA

**Input** (satu dokumen per kandidat yang dievaluasi):
```json
{
  "task": {"type": "string", "data_classification": "public|internal|confidential|restricted"},
  "candidate": {"kind": "model|tool", "id": "string", "vendor": "string", "cost_per_1k_tokens": 0.0},
  "org": {"budget_remaining_usd": 0.0, "region": "string"}
}
```

**Output** (query standar yang dipanggil per kandidat, hasil gabungan semua file `hard/*.rego`):
```json
{
  "allow": true,
  "deny_reasons": ["string"],
  "requires_human_approval": false,
  "approval_reasons": ["string"]
}
```
Default `allow = true` kecuali ada rule yang eksplisit men-deny (pola standar OPA "default allow, explicit deny").

## 3. `epm.yaml` — soft preference & bobot MODM

```yaml
version: 1
objectives:
  - name: cost
    direction: minimize
    weight: 0.3
  - name: quality
    direction: maximize
    weight: 0.4
  - name: latency
    direction: minimize
    weight: 0.2
  - name: business_risk
    direction: minimize
    weight: 0.1
technique: topsis   # topsis | weighted_sum
```
Validasi saat load: jumlah `weight` harus mendekati 1.0 (toleransi ±0.01), setiap `name` unik, `direction` hanya `minimize`/`maximize`.

## 4. API

### 4.1 `POST /decide`

**Request**:
```json
{
  "task": {"type": "summarization", "data_classification": "internal"},
  "decision_kind": "model_selection | tool_selection | human_approval",
  "candidates": [
    {"id": "gpt-4o", "vendor": "openai", "scores": {"cost": 0.02, "quality": 0.9, "latency": 1.2, "business_risk": 0.1}}
  ],
  "policy_set": "default"
}
```

**Response**:
```json
{
  "decision_id": "uuid",
  "selected_candidate_id": "gpt-4o",
  "requires_human_approval": false,
  "ranking": [{"id": "gpt-4o", "score": 0.83}, {"id": "claude-haiku", "score": 0.71}],
  "excluded": [{"id": "llama-local", "reason": "deny: data_classification=confidential not permitted on self-hosted"}],
  "technique_used": "topsis",
  "policy_version": "epm.yaml@<git-sha>"
}
```

### 4.2 `GET /policies/{policy_set}`
Introspeksi: mengembalikan isi `epm.yaml` yang aktif + daftar file rego yang dimuat + git SHA.

### 4.3 `POST /experiment/run`
```json
{
  "scenario_dataset_version": "v1",
  "baselines": ["made", "ahp_saw", "always_strong", "always_cheap", "no_policy"]
}
```
Response: `{"run_id": "uuid", "status": "completed", "summary": {...}}`.

## 5. Dataset skenario eksperimen (file, bukan DB)

```
experiments/
  scenarios/
    v1.jsonl     # beku: 2 kandidat riil (DeepSeek saja), sudah dipakai untuk run berbiaya nyata — tidak diregenerate
    v2.jsonl     # 3 kandidat riil (+ gemma4-12b via Ollama), dataset untuk eksperimen lanjutan (lihat DESIGN_MADE.md §17)
  ahp_weights.yaml   # bobot statis expert untuk baseline AHP-SAW (terpisah dari epm.yaml agar baseline tidak "curang" pakai bobot MODM)
  generate_scenarios.py   # generator: task_type x data_classification x budget_level x template prompt, reproducible via seed; daftar real_candidates dapat dikonfigurasi (bukan hardcode 2 model)
```

Satu baris `v2.jsonl` (kombinasi kandidat riil multi-provider + kandidat sintetis untuk uji jalur deny):
```json
{
  "scenario_id": "s-001",
  "task": {"type": "contract_review", "data_classification": "confidential"},
  "prompt": "Tinjau klausul berikut untuk risiko hukum: ...",
  "real_candidates": ["deepseek-v4-flash", "deepseek-v4-pro", "gemma4-12b"],
  "synthetic_candidates": [
    {"id": "local-llama", "vendor": "unverified-oss", "kind": "model", "cost_per_1k_tokens": 0.0, "scores": {"cost": 0.0, "quality": 0.5, "latency": 2000.0, "business_risk": 0.4}}
  ],
  "org": {"budget_remaining_usd": 0.05, "region": "us"},
  "policy_set": "default"
}
```
`real_candidates` diisi cost/quality/latency dari cache (§6.2) saat harness berjalan — harness memilih `deepseek_client`/`ollama_client` per kandidat berdasarkan field `provider` di `config/candidates.yaml` (§7); `business_risk` untuk tiap kandidat riil diambil dari nilai tetap yang sama.

## 6. Tabel SQLite

### 6.1 Tabel operasional (sudah ada)

```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMP,
  decision_kind TEXT,
  request_json TEXT,
  response_json TEXT,
  policy_version TEXT
);
```

### 6.2 Tabel eksperimen (baru)

```sql
CREATE TABLE score_cache (
  scenario_id TEXT,
  candidate_id TEXT,
  cost_usd REAL,
  quality REAL,          -- 0-1, dari judge (deepseek-v4-pro)
  latency_ms REAL,
  business_risk REAL,
  raw_response TEXT,      -- teks respons asli, untuk audit/debug
  judge_raw TEXT,          -- output mentah judge, untuk audit
  created_at TIMESTAMP,
  PRIMARY KEY (scenario_id, candidate_id)
);
-- Dicek dulu oleh harness sebelum memanggil DeepSeek — cache-hit tidak memicu API call.

CREATE TABLE experiment_runs (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMP,
  baseline TEXT,          -- 'made' | 'ahp_saw' | 'always_strong' | 'always_cheap' | 'no_policy'
  scenario_dataset_version TEXT
);

CREATE TABLE experiment_results (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES experiment_runs(id),
  scenario_id TEXT,
  selected_candidate_id TEXT,
  policy_violation BOOLEAN,   -- hasil cek ULANG via OPA (ground truth), independen dari apakah baseline itu policy-aware
  cost_usd REAL,
  quality_score REAL,
  latency_ms REAL,
  status TEXT                 -- 'ok' | 'failed' (API gagal setelah retry, skenario dilewati)
);
```

## 7. `config/candidates.yaml` — kandidat riil (multi-provider) + sintetis

Field `provider` menentukan client mana yang dipanggil harness untuk kandidat `source: real` (lihat `DESIGN_MADE.md` §14 — satu client kecil per provider, bukan client generik).

```yaml
models:
  - id: deepseek-v4-flash
    vendor: deepseek
    kind: model
    source: real           # skor cost/quality/latency diisi runtime dari API + judge, bukan statis
    provider: deepseek       # dispatch ke core/experiment/deepseek_client.py
    business_risk: 0.25     # nilai tetap, bukan hasil pengukuran (lihat DESIGN_MADE.md §9)
  - id: deepseek-v4-pro
    vendor: deepseek
    kind: model
    source: real
    provider: deepseek
    business_risk: 0.15
  - id: gemma4-12b
    vendor: ollama-local     # bukan unverified-oss — lolos compliance/privacy tanpa ubah Rego (DESIGN_MADE.md §15)
    kind: model
    source: real
    provider: ollama          # dispatch ke core/experiment/ollama_client.py
    business_risk: 0.1         # lebih rendah dari deepseek-v4-pro — data tidak keluar mesin
  - id: local-llama          # tetap ada: kandidat sintetis untuk memicu jalur deny compliance/security
    vendor: unverified-oss
    kind: model
    source: synthetic
    cost_per_1k_tokens: 0.0
    scores: {cost: 0.0, quality: 0.5, latency: 2000.0, business_risk: 0.4}
tools:                        # tidak berubah dari v1 — tetap sepenuhnya sintetis, DeepSeek bukan tool
  - id: web_search
    vendor: internal
    kind: tool
    cost_per_1k_tokens: 0.001
    scores: {cost: 0.001, quality: 0.8, latency: 0.5, business_risk: 0.1}
  - id: shell_exec
    vendor: internal
    kind: tool
    cost_per_1k_tokens: 0.0
    scores: {cost: 0.0, quality: 0.9, latency: 0.2, business_risk: 0.5}
```

## 8. `experiments/ahp_weights.yaml`

```yaml
version: 1
weights:
  cost: 0.25
  quality: 0.5
  latency: 0.15
  business_risk: 0.1
```
