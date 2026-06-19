# Design — Benchmark Unification (v2 — Post-Review)

**Changelog:** v2 incorporates review feedback. Key changes: DB-configurable weights,
continuous exponential decay, canonical model keys, dirty-row incremental recomputation,
sync mutex, NIM routing deferred to Phase 2, Phase 2 Bayesian blending algorithm,
canary assertions, composite versioning, rollback docs.

---

## D1: Current Architecture (As-Is) — UNCHANGED

See v1. Three sources write `benchmark_score` with conflicting strategies.
Self-hosted NIMStats is dead code. Sequential fetches on boot.

---

## D2: Target Architecture (To-Be — v2)

```
Boot / POST /api/benchmarks/sync
         │
         ▼
  BenchmarkService.updateAllBenchmarkScores()
    │  (acquires isSyncing mutex — R7.6)
    │
    │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │  │ Promise A    │  │ Promise B    │  │ Promise C    │
    │  │ AA live      │  │ SWE-rebench  │  │ NIM remote   │
    │  │              │  │              │  │              │
    │  │ writes:      │  │ writes:      │  │ writes:      │
    │  │ aa_score     │  │ swe_rebench  │  │ nim_score    │
    │  │ aa_updated   │  │ _score       │  │ nim_updated  │
    │  │ aa_confidence│  │ _updated     │  │ nim_conf     │
    │  │              │  │ _confidence  │  │ nim_avg_ms   │
    │  │              │  │              │  │ nim_tps      │
    │  │ returns:      │  │ returns:     │  │ nim_uptime   │
    │  │ affectedIds  │  │ affectedIds  │  │              │
    │  └──────┬───────┘  └──────┬───────┘  │ returns:      │
    │         │                 │          │ affectedIds   │
    │         │                 │          └──────┬───────┘
    │   ┌─────┴─────────────────┴─────────────────┘
    │   │  Promise.allSettled()
    │   ▼
    │  recomputeBenchmarkComposite(affectedIds)   ← INCREMENTAL (R7.5)
    │    ├── Read weights from benchmark_source_weights table
    │    ├── For each affected model:
    │    │     read per-source scores + timestamps + confidence
    │    │     apply exponential decay: weight × confidence × pow(0.5, age/10)
    │    │     compute weighted average → benchmark_score
    │    │     canary assert: score ∈ [0,100], not NaN/Infinity
    │    │     derive size_label + intelligence_rank
    │    │     set benchmark_composite_version = COMPOSITE_VERSION
    │    └── Transactional write
    │
    ▼
  Release isSyncing mutex. Return per-source results.
```

**Phase 1:** NIM speed/reliability columns stored but **not blended** into `scoreChainEntry()`.
Logged for correlation analysis only (R9.4).

**Phase 2 (future):** After correlation study, integrate with true Bayesian blending + sample-size decay.

---

## D3: DB Schema Changes (v2)

### New columns on `models` table

```sql
-- V34 migration: benchmark source attribution
ALTER TABLE models ADD COLUMN aa_score REAL;
ALTER TABLE models ADD COLUMN aa_score_updated TEXT;
ALTER TABLE models ADD COLUMN aa_confidence REAL DEFAULT 1.0;
ALTER TABLE models ADD COLUMN swe_rebench_score REAL;
ALTER TABLE models ADD COLUMN swe_rebench_score_updated TEXT;
ALTER TABLE models ADD COLUMN swe_rebench_confidence REAL DEFAULT 1.0;
ALTER TABLE models ADD COLUMN nim_score REAL;
ALTER TABLE models ADD COLUMN nim_score_updated TEXT;
ALTER TABLE models ADD COLUMN nim_confidence REAL DEFAULT 1.0;

-- NIM speed & reliability signals (Phase 1: store + observe only)
ALTER TABLE models ADD COLUMN nim_avg_response_ms REAL;
ALTER TABLE models ADD COLUMN nim_throughput_tps REAL;
ALTER TABLE models ADD COLUMN nim_uptime_pct REAL;

-- Canonical model identity for safe source matching
ALTER TABLE models ADD COLUMN canonical_model_key TEXT;

-- Composite versioning
ALTER TABLE models ADD COLUMN benchmark_composite_version INTEGER;
```

### New config table

```sql
CREATE TABLE IF NOT EXISTS benchmark_source_weights (
  source TEXT PRIMARY KEY,        -- 'aa', 'swe_rebench', 'nim'
  weight REAL NOT NULL,           -- base weight [0, 1]
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO benchmark_source_weights VALUES
  ('aa', 0.50, datetime('now')),
  ('swe_rebench', 0.30, datetime('now')),
  ('nim', 0.15, datetime('now'));
```

### Existing columns (unchanged)

| Column | Type | Notes |
|--------|------|-------|
| `benchmark_score` | REAL | Now derived composite, not directly written |
| `last_benchmark_update` | TEXT | `MAX(aa_score_updated, swe_rebench_score_updated, nim_score_updated)` |

### Column relationships

```
aa_score × aa_confidence ──────────────┐
swe_rebench_score × swe_confidence ──────┤──► benchmark_score (composite v2)
nim_score × nim_confidence ────────────┘         │
   × exponential freshness                     ├──► size_label
                                               └──► intelligence_rank

[Phase 2 only:]
nim_avg_response_ms ───► scoreChainEntry() speed axis (env-var gated)
nim_throughput_tps  ───► scoreChainEntry() speed axis (env-var gated)
nim_uptime_pct      ───► scoreChainEntry() reliability axis (env-var gated)
```

### Rollback (down-migration V34)

```sql
-- Safety: restore composite from most authoritative source
UPDATE models SET benchmark_score = COALESCE(aa_score, swe_rebench_score, nim_score)
WHERE benchmark_score IS NULL OR benchmark_score = 0;

-- Drop all V34 columns
ALTER TABLE models DROP COLUMN aa_score;
ALTER TABLE models DROP COLUMN aa_score_updated;
ALTER TABLE models DROP COLUMN aa_confidence;
ALTER TABLE models DROP COLUMN swe_rebench_score;
ALTER TABLE models DROP COLUMN swe_rebench_score_updated;
ALTER TABLE models DROP COLUMN swe_rebench_confidence;
ALTER TABLE models DROP COLUMN nim_score;
ALTER TABLE models DROP COLUMN nim_score_updated;
ALTER TABLE models DROP COLUMN nim_confidence;
ALTER TABLE models DROP COLUMN nim_avg_response_ms;
ALTER TABLE models DROP COLUMN nim_throughput_tps;
ALTER TABLE models DROP COLUMN nim_uptime_pct;
ALTER TABLE models DROP COLUMN canonical_model_key;
ALTER TABLE models DROP COLUMN benchmark_composite_version;

DROP TABLE IF EXISTS benchmark_source_weights;
```

---

## D4: Composite Arbitration Algorithm (v2 — Continuous Decay + Confidence)

```typescript
// ── Config (loaded from benchmark_source_weights table) ──────────────
interface SourceWeights {
  aa: number;        // default 0.50
  sweRebench: number; // default 0.30
  nim: number;        // default 0.15
}

const STALE_HALF_LIFE_DAYS = 10;
const COMPOSITE_VERSION = 1; // bump when algorithm changes

// ── Exponential freshness decay ───────────────────────────────────────
function freshnessFactor(updatedStr: string | null): number {
  if (!updatedStr) return 0;
  const ageDays = (Date.now() - new Date(updatedStr).getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / STALE_HALF_LIFE_DAYS);
}

// ── Composite computation ─────────────────────────────────────────────
function computeBenchmarkComposite(row: {
  aa_score: number | null;           aa_score_updated: string | null;  aa_confidence: number | null;
  swe_rebench_score: number | null;  swe_rebench_score_updated: string | null; swe_rebench_confidence: number | null;
  nim_score: number | null;         nim_score_updated: string | null; nim_confidence: number | null;
}, weights: SourceWeights): number | null {
  const entries = [
    {
      score: row.aa_score,
      weight: weights.aa
            * (row.aa_confidence ?? 1.0)
            * freshnessFactor(row.aa_score_updated),
    },
    {
      score: row.swe_rebench_score,
      weight: weights.sweRebench
            * (row.swe_rebench_confidence ?? 1.0)
            * freshnessFactor(row.swe_rebench_score_updated),
    },
    {
      score: row.nim_score,
      weight: weights.nim
            * (row.nim_confidence ?? 1.0)
            * freshnessFactor(row.nim_score_updated),
    },
  ].filter(e => e.score != null && e.score > 0 && e.weight > 0);

  if (entries.length === 0) return null;

  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  const weightedSum = entries.reduce((sum, e) => sum + e.score! * e.weight, 0);

  return weightedSum / totalWeight;
}
```

### Canaries

```typescript
function validateComposite(score: number | null): boolean {
  return score != null
    && !isNaN(score)
    && isFinite(score)
    && score >= 0
    && score <= 100;
}
```

### Worked examples (v2 decay)

| AA | SWE | NIM | Freshness | Composite |
|----|-----|-----|-----------|-----------|
| 58 (fresh, conf=1.0) | 52 (fresh, conf=1.0) | 48 (fresh, conf=1.0) | All 1.0 | (58×0.50 + 52×0.30 + 48×0.15) / 0.95 = **55.47** |
| 58 (fresh) | 52 (fresh) | — | — | (58×0.50 + 52×0.30) / 0.80 = **57.25** |
| 58 (10d stale, fresh=0.5) | 52 (fresh) | 48 (fresh) | | (58×0.25 + 52×0.30 + 48×0.15) / 0.70 = **53.14** |
| 58 (SWE fallback, conf=0.6) | — | — | | Single source: **58** (confidence only affects multi-source) |
| — | — | — | | **NULL** |

**Note on "all equally stale" collapsing:** All three reviewers observed that if all
sources have the same age, the freshness factors cancel out. This is correct — the
composite just tracks relative source trust. If you want absolute staleness penalties
(e.g., "don't use scores older than 30 days at all"), add a `MAX_STALE_DAYS` cutoff.
This is deferred to Phase 2 tuning — not needed at launch.

---

## D5: Source Fetch Separation (v2)

### D5.1: AA fetch — same as v1 but with canonical key matching

**File:** `server/src/db/benchmark-scores.ts` (renamed to `fetchAAScores`)

Changes:
- Write to `aa_score` + `aa_score_updated` + `aa_confidence` (always 1.0).
- Match via `canonical_model_key` not `LOWER(model_id) LIKE`.
- Track `affectedIds: Set<number>` for incremental recomputation.
- No `size_label` / `intelligence_rank` writes (moves to composite).
- Keep 4hr cache + 10s timeout.

```sql
UPDATE models SET aa_score = ?, aa_score_updated = ?, aa_confidence = 1.0
WHERE canonical_model_key = ?
```

### D5.2: SWE-rebench fetch — same as v1 but with canonical key + confidence

**File:** `server/src/services/benchmarks.ts` → `fetchSWERebenchScores()`

Changes:
- Write to `swe_rebench_score` + `swe_rebench_score_updated` + `swe_rebench_confidence`.
  - Live scrape success: confidence = 1.0
  - Hardcoded fallback: confidence = 0.6
- Match via `canonical_model_key`.
- Track `affectedIds: Set<number>`.

```sql
UPDATE models SET swe_rebench_score = ?, swe_rebench_score_updated = ?, swe_rebench_confidence = ?
WHERE canonical_model_key = ?
```

### D5.3: NIM remote fetch — single direct fetch, canonical keys, upsert

**File:** `server/src/services/benchmarks.ts` → `fetchNIMBenchmarks()`

Changes:
- **No** self-hosted fallback. Single fetch to remote.
- Write to `nim_score` + `nim_score_updated` + `nim_confidence` (always 1.0)
  + `nim_avg_response_ms` + `nim_throughput_tps` + `nim_uptime_pct`.
- Match via `canonical_model_key`.
- Track `affectedIds: Set<number>`.
- Always upsert (no NULL-only guard).

```sql
UPDATE models SET nim_score = ?, nim_score_updated = ?, nim_confidence = 1.0,
  nim_avg_response_ms = ?, nim_throughput_tps = ?, nim_uptime_pct = ?
WHERE canonical_model_key = ?
```

---

## D6: Composite Recomputation Step (v2 — Incremental)

**Function:** `recomputeBenchmarkComposite(db, affectedIds: Set<number>, weights: SourceWeights): number`

```typescript
function recomputeBenchmarkComposite(
  db: Database.Database,
  affectedIds: Set<number>,
  weights: SourceWeights,
): number {
  if (affectedIds.size === 0) return 0;

  const idList = [...affectedIds].join(',');
  const rows = db.prepare(`
    SELECT id, aa_score, aa_score_updated, aa_confidence,
           swe_rebench_score, swe_rebench_score_updated, swe_rebench_confidence,
           nim_score, nim_score_updated, nim_confidence
    FROM models
    WHERE id IN (${idList})
  `).all() as any[];

  const updateComposite = db.prepare(`
    UPDATE models SET
      benchmark_score = ?,
      last_benchmark_update = ?,
      size_label = ?,
      intelligence_rank = ?,
      benchmark_composite_version = ?
    WHERE id = ?
  `);

  let updated = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const composite = computeBenchmarkComposite(row, weights);
      if (!validateComposite(composite)) {
        console.warn(`[Benchmarks] Invalid composite for model id=${row.id}: ${composite} — skipping`);
        continue;
      }

      // Compute composite timestamp = max of available source timestamps
      const timestamps = [row.aa_score_updated, row.swe_rebench_score_updated, row.nim_score_updated]
        .filter((t: string | null) => t != null)
        .map((t: string) => new Date(t).getTime());
      const lastUpdate = timestamps.length > 0
        ? new Date(Math.max(...timestamps)).toISOString()
        : null;

      updateComposite.run(
        composite,
        lastUpdate,
        scoreToTier(composite),
        scoreToIntelligenceRank(composite),
        COMPOSITE_VERSION,
        row.id,
      );
      updated++;
    }
  });
  tx();

  return updated;
}
```

---

## D7: Router Integration — Phase 2 Design (Store + Observe in Phase 1)

### Phase 1 (this spec)

`scoreChainEntry()` is **not modified**. NIM speed/reliability columns exist in the
DB and are SELECTed in `buildChain()` but are **only logged**, never blended.

**Logging in `scoreChainEntry()`:**
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

### Phase 2 (future spec) — True Bayesian blending

#### D7.2: Speed axis — Bayesian virtual requests (NOT hard fallback)

The v1 spec used `??` coalescing which created a "1-request cliff": the moment
a single local request arrives, the high-confidence NIM prior is entirely lost.

**Phase 2 fix — weighted blend, not hard switch:**
```typescript
const NIM_SPEED_VIRTUAL_REQUESTS = parseInt(process.env.NIM_SPEED_VIRTUAL_REQUESTS ?? '25', 10);
const NIM_SPEED_BLEND_WEIGHT = parseFloat(process.env.NIM_SPEED_BLEND_WEIGHT ?? '0.0', 10);

const nimTokPerSec = entry.nim_throughput_tps ?? 0;
const nimTtfbMs = entry.nim_avg_response_ms ?? null;

let effectiveTokPerSec = stats?.tokPerSec ?? 0;
let effectiveTtfbMs = stats?.avgTtfbMs ?? null;
let effectiveRequests = totalRequests;

if (nimTokPerSec > 0 && NIM_SPEED_BLEND_WEIGHT > 0) {
  if (totalRequests === 0) {
    // No local data — use NIM directly at virtual confidence
    effectiveTokPerSec = nimTokPerSec;
    effectiveTtfbMs = nimTtfbMs;
    effectiveRequests = NIM_SPEED_VIRTUAL_REQUESTS;
  } else {
    // Smoothly blend NIM prior with local data
    const totalWeight = totalRequests + NIM_SPEED_VIRTUAL_REQUESTS;
    effectiveTokPerSec = (
      (stats!.tokPerSec * totalRequests) +
      (nimTokPerSec * NIM_SPEED_VIRTUAL_REQUESTS)
    ) / totalWeight;

    if (effectiveTtfbMs != null && nimTtfbMs != null) {
      effectiveTtfbMs = (
        (stats!.avgTtfbMs! * totalRequests) +
        (nimTtfbMs * NIM_SPEED_VIRTUAL_REQUESTS)
      ) / totalWeight;
    }
    effectiveRequests = totalWeight;
  }
}

const speed = heavyWeightedSpeedScore(effectiveTokPerSec, effectiveTtfbMs, effectiveRequests, defaultSpeed);
```

Key property: as `totalRequests` grows, the NIM contribution is mathematically
overwhelmed by empirical data. No cliff at request #1.

#### D7.3: Reliability axis — sample-size-decay blending

The v1 spec used a fixed 25% weight for NIM reliability, which never decays
even with 10K local requests.

**Phase 2 fix — NIM weight decays to zero as local data accumulates:**
```typescript
const NIM_RELIABILITY_BLEND_MAX = parseFloat(process.env.NIM_RELIABILITY_BLEND_WEIGHT ?? '0.0', 10);
const NIM_RELIABILITY_DECAY_REQUESTS = 100; // weight → 0 at this many local requests

// NIM weight decays linearly from NIM_RELIABILITY_BLEND_MAX to 0
const localSamples = successes + failures;
const nimWeight = NIM_RELIABILITY_BLEND_MAX * Math.max(0, 1 - (localSamples / NIM_RELIABILITY_DECAY_REQUESTS));

if (entry.nim_uptime_pct != null && nimWeight > 0) {
  const nimReliability = entry.nim_uptime_pct / 100;
  if (localSamples > 0) {
    reliability = (1 - nimWeight) * betaReliability + nimWeight * nimReliability;
  } else {
    reliability = nimReliability; // no local data, trust NIM
  }
} else {
  reliability = betaReliability; // no NIM data or weight is 0
}
```

Key property: at `localSamples = 0` → NIM dominates. At `localSamples = 100` → NIM
influence is 0. The bandit's self-correcting property is preserved.

**Important assumption documented:** NIM's `uptime_pct` measures success on
NVIDIA's hosted NIM infrastructure with a specific prompt (`temperature: 0.7`,
`max_tokens: 500`). This may not perfectly correlate with our proxy's observed
failure modes (rate limits, circuit breakers, different prompt profiles).
Phase 2 must include a correlation study before enabling the blend.

---

## D8: API Response Changes — UNCHANGED from v1

`POST /api/benchmarks/sync` returns per-source breakdown.
`GET /api/benchmarks/scores` includes per-source breakdown with `sources` field.

---

## D9: File Map — Updated

| File | Change | Scope |
|------|--------|-------|
| `server/src/services/benchmarks.ts` | Refactor `BenchmarkService`: remove self-hosted, parallel fetch + composite, NIM direct + canonical matching | Major |
| `server/src/db/benchmark-scores.ts` | Rename `fetchLiveBenchmarkScores` → `fetchAAScores`, per-source writes + canonical + confidence + affectedIds | Major |
| `server/src/services/router.ts` | Phase 1: SELECT new columns + log NIM metrics. Phase 2 (future): blend in `scoreChainEntry()` | Medium (Phase 1) |
| `server/src/db/migrations.ts` | Add V34 migration (13 new columns + weights table + canonical keys + composite version) | Major |
| `server/src/routes/benchmarks.ts` | Update sync/scores response shapes | Minor |
| `server/src/services/benchmarks.ts` | `BenchmarkService` gains `isSyncing` mutex, `canonicalizeModelId()` function | Medium |
| `server/src/services/swe-rebench-parser.ts` | No changes | — |
| Tests | Update per-source model, add composite canary tests, add canonical key tests | Medium |

---

## D10: Migration Strategy — Updated

1. **V34 migration** adds 13 nullable columns + 1 config table + populates
   `canonical_model_key` for all existing models. No data loss.
2. **Canonical key backfill:** The migration runs
   `UPDATE models SET canonical_model_key = canonicalizeModelId(model_id)` for
   all rows. This is O(N) but fast (pure string ops in JS, UPDATE batch).
3. **Backfill:** On first boot after V34, the static `BENCHMARK_SCORES` table
   populates `benchmark_score` as before. Then parallel fetch runs. Once per-source
   data arrives, the composite step overwrites `benchmark_score` with the fused value.
4. **No downtime:** All new columns are nullable. Old code reading `benchmark_score`
   still works.
5. **Rollback:** Documented in D3 above. `COALESCE(aa_score, swe_rebench_score, nim_score)`
   provides a safety-net benchmark_score before dropping columns.

---

## D11: Sequence Diagram (v2)

```
Client         BenchmarkService          AA Fetcher      SWE Fetcher      NIM Fetcher       DB
  │                   │                      │                │                │              │
  │── POST /sync ──►│                      │                │                │              │
  │                   │── acquire mutex ────────────────────────────────────────────────────►│
  │                   │──── fetchAAScores() ──►│             │                │              │
  │                   │──── fetchSWEScores() ──────────────►│                │              │
  │                   │──── fetchNIMScores() ─────────────────────────────►│              │
  │                   │                      │                │                │              │
  │                   │   ◄── aa_score +     │               │                │              │
  │                   │        affectedIds   │               │                │   WRITE ──►│
  │                   │   ◄── swe_score + ──────────────────│               │   WRITE ──►│
  │                   │        affectedIds                   │               │              │
  │                   │   ◄── nim_score + speed + ──────────────────────────│   WRITE ──►│
  │                   │        affectedIds                   │               │              │
  │                   │                      │                │                │              │
  │                   │── recomputeBenchmarkComposite(affectedIds) ──────────────────────────►│
  │                   │   (reads weights from config table)                    UPDATE ──►│
  │                   │                      │                │                │              │
  │                   │── release mutex ────────────────────────────────────────────────────►│
  │   ◄── {sources} ──│                      │                │                │              │
```

All three fetches run concurrently. Only affected models are recomputed.
The composite step is bounded by the number of models touched by this sync (not all models).
