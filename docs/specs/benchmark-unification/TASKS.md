# Tasks — Benchmark Unification (v2 — Post-Review)

**Changelog:** v2 reflects all three reviewers' feedback. Key changes:
- New Task 1.2 (canonical model key)
- Task 3.3 split into Phase 1 (log only) + Phase 2 placeholder (Bayesian blend)
- New Task 2.4 (composite function with exponential decay + confidence)
- New Task 2.9 (sync mutex)
- NIM weight reduced from 0.20 → 0.15
- All tasks use canonical_model_key instead of LIKE

---

## Phase 1: DB Schema + Canonical Identity

### Task 1.1 — V34 Migration (Per-Source + Config + Versioning)
**Dependencies:** None
**Files:** `server/src/db/migrations.ts`
**Symbol to create:** `migrateModelsV34` (new function)
**Context symbols:**
- `server/src/db/migrations.ts::ensureModelsBenchmarkColumns#function`
- `server/src/db/migrations.ts::migrateModelsV33BenchmarkScore#function`

**Work:**
1. Add 13 new nullable columns to `models`:
   - `aa_score REAL`, `aa_score_updated TEXT`, `aa_confidence REAL DEFAULT 1.0`
   - `swe_rebench_score REAL`, `swe_rebench_score_updated TEXT`, `swe_rebench_confidence REAL DEFAULT 1.0`
   - `nim_score REAL`, `nim_score_updated TEXT`, `nim_confidence REAL DEFAULT 1.0`
   - `nim_avg_response_ms REAL`, `nim_throughput_tps REAL`, `nim_uptime_pct REAL`
   - `canonical_model_key TEXT`
   - `benchmark_composite_version INTEGER`
2. Create `benchmark_source_weights` config table with default seed:
   - `('aa', 0.50, now)`, `('swe_rebench', 0.30, now)`, `('nim', 0.15, now)`
3. Wire into migration pipeline.
4. Document rollback (see REQUIREMENTS.md R8.5).
5. Log `✅ V34: Added benchmark source attribution + canonical keys + composite versioning`.

**Validation:** `PRAGMA table_info(models)` shows 13 new columns. `SELECT * FROM benchmark_source_weights` returns 3 rows.

---

### Task 1.2 — Canonical Model Key Population [NEW]
**Dependencies:** Task 1.1
**Files:** `server/src/db/benchmark-scores.ts` (or new file `server/src/services/canonical-model.ts`)
**Symbol to create:** `canonicalizeModelId` (new function)

**Work:**
1. Implement `canonicalizeModelId()` per R10.2:
   ```typescript
   function canonicalizeModelId(modelId: string): string {
     return modelId
       .toLowerCase()
       .replace(/^[a-z0-9-]+\//, '')
       .replace(/[-_]/g, '-')
       .replace(/-(instruct|chat|it|hf)$/, '')
       .replace(/\.(\d+)(?=\D|$)/g, '-$1');
   }
   ```
2. Add a migration step in V34 that backfills all existing models:
   ```javascript
   const models = db.prepare('SELECT id, model_id FROM models').all();
   const update = db.prepare('UPDATE models SET canonical_model_key = ? WHERE id = ?');
   const tx = db.transaction(() => {
     for (const m of models) {
       update.run(canonicalizeModelId(m.model_id), m.id);
     }
   });
   tx();
   ```
3. Export `canonicalizeModelId` for use in source fetchers and auto-sync.

**Validation:** After migration, `SELECT model_id, canonical_model_key FROM models LIMIT 5` shows sensible normalization (e.g., `meta/llama-3.3-70b-instruct` → `llama-3-3-70b`).

---

## Phase 2: Benchmark Service Refactor

### Task 2.1 — Purge Self-Hosted NIM + Restructure `BenchmarkService.sources`
**Dependencies:** None (parallel with Task 1.1)
**Files:** `server/src/services/benchmarks.ts`
**Context symbols:**
- `server/src/services/benchmarks.ts::BenchmarkService#class`
- `server/src/services/benchmarks.ts::BenchmarkSource#type`

**Work:**
1. Remove `NIM Self-Hosted` entry from `sources` array.
2. Array now: `[SWE-rebench, NIM Remote]`. Update index references.
3. Remove `apiKey` field from `BenchmarkSource` (unused).

**Validation:** `this.sources.length === 2`.

---

### Task 2.2 — Rewrite `fetchNIMBenchmarks()` to Single Direct Fetch
**Dependencies:** Task 2.1
**Files:** `server/src/services/benchmarks.ts`
**Symbol to edit:** `BenchmarkService.fetchNIMBenchmarks#method`

**Work:**
Replace the try-local-then-fallback chain with a single direct call:
```typescript
async fetchNIMBenchmarks(): Promise<BenchmarkScore[]> {
  return this.fetchFromSource('NIM Remote', this.sources[1].apiUrl);
}
```

**Validation:** No `localhost:3000` references.

---

### Task 2.3 — Extend NIM Fetch to Return Speed & Reliability Data
**Dependencies:** Task 2.2
**Files:** `server/src/services/benchmarks.ts`
**Symbol to edit:** `BenchmarkScore#type`, `BenchmarkService.fetchFromSource#method`

**Work:**
1. Extend `BenchmarkScore` with optional NIM fields:
   ```typescript
   avgResponseMs?: number;
   throughputTps?: number;
   uptimePct?: number;
   ```
2. Update `fetchFromSource` NIM parser to extract `avg_response_time`, `throughput`, `uptime_pct`.

**Validation:** `BenchmarkScore` with `source: 'NIM'` can carry speed/reliability fields.

---

### Task 2.4 — Create `recomputeBenchmarkComposite()` + Exponential Decay + Confidence [REVISED]
**Dependencies:** Task 1.1
**Files:** `server/src/db/benchmark-scores.ts` (or new `server/src/db/benchmark-composite.ts`)
**Symbol to create:** `recomputeBenchmarkComposite`, `computeBenchmarkComposite`, `freshnessFactor`, `validateComposite`

**Work:**
1. Implement `freshnessFactor()` — exponential decay: `pow(0.5, ageDays / 10)`.
2. Implement `computeBenchmarkComposite()` — reads per-source scores + confidence + timestamps, applies freshness × confidence × base_weight, returns weighted average. See DESIGN.md D4.
3. Implement `validateComposite()` — canary: score ∈ [0,100], not NaN/Infinity.
4. Implement `recomputeBenchmarkComposite(db, affectedIds, weights)` — incremental, only processes `affectedIds`. See DESIGN.md D6.
5. Add weight-loading function: `loadSourceWeights(db): SourceWeights` that reads from `benchmark_source_weights` table with in-memory cache.
6. Define `COMPOSITE_VERSION = 1`, `STALE_HALF_LIFE_DAYS = 10`.

**Validation:** Unit tests:
- `freshnessFactor(0 days) = 1.0`
- `freshnessFactor(10 days) ≈ 0.5`
- `computeBenchmarkComposite({aa: 60, swe: null, nim: null}) = 60`
- `validateComposite(NaN) = false`
- `validateComposite(55) = true`

---

### Task 2.5 — Rewrite `updateAllBenchmarkScores()` for Parallel + Composite Pipeline
**Dependencies:** Tasks 2.2, 2.3, 2.4
**Files:** `server/src/services/benchmarks.ts`
**Symbol to edit:** `BenchmarkService.updateAllBenchmarkScores#method`

**Work:**
1. Restructure to `Promise.allSettled([fetchAAScores, fetchSWEScores, fetchNIMBenchmarks])`.
2. Collect `affectedIds` from each settled result.
3. Load weights from DB via `loadSourceWeights(db)`.
4. Call `recomputeBenchmarkComposite(db, affectedIds, weights)`.
5. Return per-source breakdown.

**Validation:** After sync, a model with all 3 sources has all per-source columns + composite populated.

---

### Task 2.6 — Rename `fetchLiveBenchmarkScores` → `fetchAAScores` + Per-Source Writes
**Dependencies:** Task 1.1
**Files:** `server/src/db/benchmark-scores.ts`
**Symbol to edit:** `fetchLiveBenchmarkScores#function`

**Work:**
1. Rename to `fetchAAScores`.
2. Write to `aa_score` + `aa_score_updated` + `aa_confidence = 1.0`.
3. Match via `canonical_model_key` (not `LOWER(model_id) LIKE`).
4. Remove inline `size_label` / `intelligence_rank` writes.
5. Return `{ updated: number; errors: string[]; affectedIds: Set<number> }`.

**Validation:** After `fetchAAScores`, `aa_score` columns populated, `benchmark_score` untouched.

---

### Task 2.7 — Rewrite `fetchSWERebenchScores()` for Per-Source Writes
**Dependencies:** Task 1.1
**Files:** `server/src/services/benchmarks.ts`
**Symbol to edit:** `BenchmarkService.fetchSWERebenchScores#method`

**Work:**
1. Write to `swe_rebench_score` + `swe_rebench_score_updated` + `swe_rebench_confidence`:
   - Live scrape success → confidence 1.0
   - Hardcoded fallback → confidence 0.6
2. Match via `canonical_model_key`.
3. Remove inline `size_label` / `intelligence_rank` writes.
4. Return `{ updated: number; errors: string[]; affectedIds: Set<number> }`.

**Validation:** After SWE fetch, `swe_rebench_score` + `swe_rebench_confidence` populated.

---

### Task 2.8 — Rewrite `fetchNIMBenchmarks()` for Per-Source Writes
**Dependencies:** Tasks 2.2, 2.3
**Files:** `server/src/services/benchmarks.ts`
**Symbol to edit:** `BenchmarkService.fetchNIMBenchmarks#method`

**Work:**
1. Change from returning `BenchmarkScore[]` to writing to DB directly.
2. Remove NULL-only guard. Always upsert.
3. Match via `canonical_model_key`.
4. Write SQL:
   ```sql
   UPDATE models SET nim_score = ?, nim_score_updated = ?, nim_confidence = 1.0,
     nim_avg_response_ms = ?, nim_throughput_tps = ?, nim_uptime_pct = ?
   WHERE canonical_model_key = ?
   ```
5. Return `{ updated: number; errors: string[]; affectedIds: Set<number> }`.

**Validation:** After NIM fetch, all nim_* columns populated for matching models.

---

### Task 2.9 — Add Sync Mutex [NEW]
**Dependencies:** Task 2.5
**Files:** `server/src/services/benchmarks.ts`
**Symbol to edit:** `BenchmarkService#class`

**Work:**
1. Add `private isSyncing = false;` field.
2. Wrap `updateAllBenchmarkScores()` in try/finally:
   ```typescript
   if (this.isSyncing) return { updated: 0, errors: ['Sync already in progress'], sources: {}, composite: { updated: 0 } };
   this.isSyncing = true;
   try { /* ... existing logic ... */ }
   finally { this.isSyncing = false; }
   ```

**Validation:** Two concurrent `POST /api/benchmarks/sync` calls → second returns "Sync already in progress".

---

## Phase 3: API & Router Integration

### Task 3.1 — Update `POST /api/benchmarks/sync` Response Shape
**Dependencies:** Tasks 2.5–2.9
**Files:** `server/src/routes/benchmarks.ts`

**Work:**
Update sync handler to return new per-source breakdown shape (same as v1).

**Validation:** `POST /api/benchmarks/sync` returns `sources.aa.updated`, etc.

---

### Task 3.2 — Update `GET /api/benchmarks/scores` to Include Per-Source Breakdown
**Dependencies:** Task 1.1
**Files:** `server/src/routes/benchmarks.ts`

**Work:**
1. Extend SELECT to include all per-source columns.
2. Add `sources` field to response objects per D8.2.

**Validation:** `GET /api/benchmarks/scores` response includes `scores[0].sources.aa.score`.

---

### Task 3.3 — NIM Observability in Router [REVISED — Phase 1 Only]
**Dependencies:** Task 1.1
**Files:** `server/src/services/router.ts`
**Symbols to edit:** `ChainRow` type, `scoreChainEntry#function`, `buildChain#function`, `buildFallbackChain#function`

**Work (Phase 1 — this task):**
1. Add `nim_throughput_tps`, `nim_avg_response_ms`, `nim_uptime_pct` to `ChainRow` (all `number | null`).
2. Add these 3 columns to the SELECT in `buildChain()` and `buildFallbackChain()`.
3. In `scoreChainEntry()`: when NIM metrics are present, **log them** (no blending):
   ```typescript
   if (entry.nim_throughput_tps != null || entry.nim_avg_response_ms != null) {
     console.log(
       `[Router] NIM metrics available: model=${entry.platform}/${entry.model_id}`,
       `tps=${entry.nim_throughput_tps ?? 'N/A'}`,
       `ttfb=${entry.nim_avg_response_ms ?? 'N/A'}ms`,
       `uptime=${entry.nim_uptime_pct ?? 'N/A'}%`,
       `(not blended — Phase 1)`,
     );
   }
   ```
4. **No changes** to speed or reliability scoring. The bandit is untouched.

**Future (Phase 2 — separate task):**
- Implement Bayesian speed blending (D7.2) gated by `NIM_SPEED_BLEND_WEIGHT` env var.
- Implement sample-size-decay reliability blending (D7.3) gated by `NIM_RELIABILITY_BLEND_WEIGHT` env var.
- Both default to `0.0` in Phase 1 → zero influence until explicitly enabled.

**Validation:** NIM models' metrics appear in server logs when routing. Routing decisions are unchanged from current behavior.

---

## Phase 4: Tests & Cleanup

### Task 4.1 — Update Benchmark Tests
**Dependencies:** All Phase 2–3 tasks

**Work:**
1. Update model INSERTs in tests to include new per-source columns (or rely on nullable defaults).
2. Add tests for `computeBenchmarkComposite()` with various source combinations.
3. Add tests for `freshnessFactor()` at 0d, 5d, 10d, 20d, 30d.
4. Add tests for `validateComposite()` (NaN, Infinity, negative, >100, valid).
5. Add tests for `canonicalizeModelId()` with edge cases:
   - `meta/llama-3.3-70b-instruct` → `llama-3-3-70b`
   - `deepseek-ai/deepseek-v4-flash` → `deepseek-v4-flash`
   - `google/gemma-4-31b-it` → `gemma-4-31b`
6. Add test that concurrent sync calls are rejected by mutex.
7. Verify existing routing tests pass (no regression).

**Validation:** `npm test` passes.

### Task 4.2 — Remove Dead Code Paths
**Dependencies:** Tasks 2.1, 2.2

**Work:**
1. Remove all `localhost:3000` references.
2. Remove self-hosted NIM rate limit config.
3. Remove TODO/FIXME comments about "self-hosted" or "localhost NIM".

**Validation:** `grep -r localhost:3000 server/src/` returns zero results.

---

## Execution Order (v2)

```
Phase 1:  Task 1.1 (V34 migration)
               │
          Task 1.2 (canonical keys — after 1.1)
               │
Phase 2:  ┌────┴────┬──────────┬──────────┐
          │ Task 2.1 │Task 2.6* │ Task 2.2  │
          │ Purge    │ Rename AA│ Simpl.    │
          │ sources  │ per-col  │ NIM fetch │
          └────┬─────┴──────────┴────┬──────┘
               │                     │
          Task 2.3 (extend NIM)      │
               │                     │
          ┌────┴────────┐           │
          │ Task 2.7    │ Task 2.8  │
          │ SWE writes  │ NIM writes│
          └────┬────────┴────┬──────┘
               │             │
          Task 2.4 (composite + decay + confidence)
               │
          Task 2.5 (parallel pipeline)
               │
          Task 2.9 (sync mutex)
               │
Phase 3:  ┌────┼──────────┐
          │ Task 3.1     │ Task 3.3 (router observability — Phase 1)
          │ sync response│
          │     │        │
          │ Task 3.2     │
          │ scores API   │
          └────┼──────────┘
               │
Phase 4:  Task 4.1 + 4.2 (tests + cleanup)
```

---

## Parallelization Opportunities

| Group | Tasks | Rationale |
|-------|-------|-----------|
| A | 1.1 + 2.1 + 2.2 | No mutual dependencies |
| B | 2.3 + 2.6 | Different files |
| C | 2.7 + 2.8 | Different methods in `benchmarks.ts` |
| D | 3.1 + 3.2 + 3.3 | Different concerns, different code areas |

---

## Review-Driven Changes vs v1 (Summary)

| v1 Issue | Review Source | v2 Fix |
|----------|---------------|--------|
| Hardcoded weights | ChatGPT, Claude | DB-configurable `benchmark_source_weights` table (R4.1) |
| LIKE matching | ChatGPT | Canonical model key column + `canonicalizeModelId()` (R10) |
| Full-table recomputation | ChatGPT, Claude | Incremental via `affectedIds` set (R7.5) |
| Step-function staleness | ChatGPT, Gemini | Continuous exponential decay `pow(0.5, age/10)` (R4.5) |
| NIM 1-request cliff | Gemini, Claude | Phase 2: Bayesian blending, not `??` coalescing (D7.2) |
| NIM fixed reliability weight | Gemini, Claude | Phase 2: Sample-size-decay to zero (D7.3) |
| NIM double-counting risk | ChatGPT, Claude | Route integration deferred to Phase 2 (R5.3) |
| No sync mutex | Gemini | `isSyncing` boolean lock (R7.6, Task 2.9) |
| No rollback strategy | Claude | Documented down-migration (R8.5, D3) |
| No composite versioning | Claude | `benchmark_composite_version` column (R8.6) |
| No confidence concept | ChatGPT, Claude | Per-source `*_confidence` columns (R2.1b) |
| NIM virtual requests hardcoded | ChatGPT, Gemini | Env-var `NIM_SPEED_VIRTUAL_REQUESTS` (R5.3b) |
| NIM weight too high | Claude | Reduced from 0.20 → 0.15 (R4.1) |
| No canary assertions | Claude | `validateComposite()` in composite step (R8.1b) |
| NIM uptime ≠ local failure modes | ChatGPT, Gemini | Documented assumption (D7.3 note) |

All three reviewers approved the core architecture. v2 addresses every "Must fix" and "Should fix" item.
