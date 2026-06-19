# Requirements — Benchmark Unification (v2 — Post-Review)

**Changelog:** v2 incorporates architectural review feedback from three
independent reviewers (ChatGPT, Gemini 3.1 Pro, Claude 4.5 Sonnet).
Changes are marked with `[NEW]` or `[REVISED]`.

---

## R1: Purge Self-Hosted NIMStats

**R1.1** Remove the `NIM Self-Hosted` source entry (`http://localhost:3000/api/benchmarks`)
from `BenchmarkService.sources` and all fallback logic that references `this.sources[1]`.

**R1.2** Remove the two-source fallback chain in `fetchNIMBenchmarks()` (try-local, then
try-external). Replace with a direct fetch to `https://nimstats.maurodruwel.be/api/v1/benchmarks`.

**R1.3** No code path in the server shall attempt a network call to `localhost:3000`
for benchmark data after this change.

---

## R2: Per-Source Score Attribution

**R2.1** Every model row in the `models` table must store benchmark scores per-source:
- `aa_score REAL` — Artificial Analysis Intelligence Index [0, 100]
- `swe_rebench_score REAL` — SWE-rebench resolved rate, normalized to [0, 100]
- `nim_score REAL` — NIMStats composite score, normalized to [0, 100]

[NEW] **R2.1b** Each per-source score also has a confidence level [0, 1]:
- `aa_score REAL` + `aa_confidence REAL` — AA live fetch → confidence 1.0
- `swe_rebench_score REAL` + `swe_rebench_confidence REAL` — live scrape → 1.0, hardcoded fallback → 0.6
- `nim_score REAL` + `nim_confidence REAL` — live fetch → 1.0

**R2.2** Each per-source column has a companion timestamp:
- `aa_score_updated TEXT`
- `swe_rebench_score_updated TEXT`
- `nim_score_updated TEXT`

**R2.3** `benchmark_score` (existing column) becomes a **derived composite** of the
three per-source scores. It is computed and stored on every sync, not computed at
query time.

**R2.4** The composite `benchmark_score` must never be overwritten by a single source.
It is always a weighted fusion of available per-source scores.

---

## R3: No Source Silently Overwrites Another

**R3.1** When a source fetch succeeds, it writes **only** its own per-source column
(`aa_score` or `swe_rebench_score` or `nim_score`) and its timestamp + confidence.
It must never touch another source's column.

**R3.2** After **all** source fetches complete (success or failure), a separate
`recomputeBenchmarkComposite()` step merges the per-source scores into
`benchmark_score` using the arbitration rules in R4.

[REVISED] **R3.3** Staleness is handled via **continuous exponential decay** (see R4.5),
not step functions. There are no discontinuities at 7d or 14d boundaries.

---

## R4: Composite Arbitration Rules

[REVISED] **R4.1** Base weights are **stored in the database** as a config table,
not hardcoded:

```sql
CREATE TABLE IF NOT EXISTS benchmark_source_weights (
  source TEXT PRIMARY KEY,
  weight REAL NOT NULL,
  updated_at TEXT NOT NULL
);
```

Default seed:
| Source | Weight | Rationale |
|--------|--------|-----------|
| Artificial Analysis | 0.50 | Broadest model coverage, industry-standard intelligence index |
| SWE-rebench | 0.30 | Coding-specific, high signal for developer workflows |
| NIMStats | 0.15 | Narrowest model set (20 NIM models) — [REVISED from 0.20 per reviewer consensus] |

Weights are read on startup with an in-memory cache. The remaining 0.05 is redistributed
to AA and SWE proportionally (i.e., effective weights become 0.526 / 0.316 / 0.158 after
renormalization). This allows runtime tuning without code deployment.

**R4.2** When a model has scores from fewer than all three sources, the present sources'
weights are re-normalized to sum to 1.0.

**R4.3** When a model has only one source, `benchmark_score` equals that source's score
(pass-through).

**R4.4** When a model has no scores from any source, `benchmark_score` remains NULL.

[REVISED] **R4.5** **Continuous exponential staleness decay** replaces the step-function.

The decay formula:
```
decayed_weight = base_weight × confidence × pow(0.5, ageDays / STALE_HALF_LIFE_DAYS)
```

Where:
- `confidence` = per-source confidence (R2.1b), typically 1.0 for live data, 0.6 for hardcoded fallback
- `STALE_HALF_LIFE_DAYS = 10` — weight halves every 10 days of age
- `ageDays` = `(now - source_updated) / (24h)`

This produces smooth, continuous weight curves with no discontinuities.
At 10 days → 50% weight. At 20 days → 25%. At 30 days → 12.5%.

[REVISED] **R4.6** The composite formula now includes confidence:
```
composite = Σ(source_score × decayed_weight) / Σ(decayed_weight)
where decayed_weight = base_weight × confidence × freshness
```

---

## R5: NIM Data Provides Speed & Reliability Signals (Phased Rollout)

**R5.1** In addition to the composite `nim_score`, NIMStats provides extra
per-model metrics stored in the `models` table:
- `nim_avg_response_ms REAL` — average response time in milliseconds
- `nim_throughput_tps REAL` — throughput in tokens/second
- `nim_uptime_pct REAL` — success rate as percentage [0, 100]

**R5.2** These are sourced from `https://nimstats.maurodruwel.be/api/v1/benchmarks`
and populated during the NIM fetch step of the sync pipeline.

[REVISED] **R5.3** **Phase 1 (this spec):** Store NIM speed/reliability columns but
**do NOT blend them into `scoreChainEntry()`**. Instead, log them alongside routing
decisions for observability. This allows correlation analysis without production risk.

[NEW] **R5.3b** **Phase 2 (future spec):** After correlation analysis confirms NIM
metrics predict local performance (r > 0.7), integrate into `scoreChainEntry()` with:
- **True Bayesian blending** for speed (not hard fallback — see D7.2)
- **Sample-size-decay** for reliability (NIM weight → 0 as local data grows — see D7.3)
- All NIM routing blend weights controlled by **env vars** (kill switches):
  - `NIM_SPEED_BLEND_WEIGHT` (default: `0.0` in Phase 1, `0.10` in Phase 2)
  - `NIM_RELIABILITY_BLEND_WEIGHT` (default: `0.0` in Phase 1, `0.10` in Phase 2)

[REVISED] **R5.4** ~~The router's reliability axis must incorporate NIM uptime data~~
**Deferred to Phase 2.** Phase 1 stores data + adds observability logging only.

**R5.5** NIM speed/reliability data only applies to models that match NIM's model list
(~20 NVIDIA NIM models). For all other models, these columns are NULL and have zero
influence.

---

## R6: NIM Remote API Contract

**R6.1** The NIM remote fetch uses only `https://nimstats.maurodruwel.be/api/v1/benchmarks`.

**R6.2** If the NIM remote API is unreachable, the sync logs a warning and continues.
Existing per-source scores are preserved; stale NIM scores decay per R4.5.

**R6.3** The API is expected to return JSON in either of these shapes:
- Primary: `{ models: [{ id, score, avg_response_time, throughput, uptime_pct }, ...] }`
- Fallback: array of same-shape objects

**R6.4** If NIM's API shape changes, the parser must fail gracefully (log + skip)
rather than throwing and aborting the entire sync.

---

## R7: Boot & Sync Behavior

**R7.1** On boot, the same fire-and-forget `updateAllBenchmarkScores()` runs, now
executing all three source fetches in **parallel** (Promise.allSettled) instead of
sequentially.

[REVISED] **R7.2** After allSettled resolves, `recomputeBenchmarkComposite()` runs
**incrementally** — only recomputing models whose per-source columns were modified
during this sync (see R7.5), not a full-table scan.

**R7.3** `POST /api/benchmarks/sync` triggers the same pipeline and returns a
per-source breakdown: `{ aa: { updated, errors }, swe: { updated, errors }, nim: { updated, errors }, composite: { updated } }`.

**R7.4** The 4-hour AA fetch cache (`FETCH_CACHE_TTL_MS`) is preserved but renamed
to a general sync throttle: `SYNC_THROTTLE_MS = 4 * 60 * 60 * 1000`. All three
sources respect this throttle.

[NEW] **R7.5** **Dirty-row tracking.** Each source fetch records the `id` of every
model row it updates. `recomputeBenchmarkComposite()` receives the union of affected
IDs and only processes those rows — not the full table. A `benchmark_dirty BOOLEAN`
column is **not** used (adds schema bloat); the affected IDs are tracked in-memory
within the sync call.

[NEW] **R7.6** **Sync mutex.** `updateAllBenchmarkScores()` acquires an `isSyncing`
boolean lock. Concurrent sync attempts return `{ error: "Sync already in progress" }`
immediately. This prevents `SQLITE_BUSY` errors and thundering-herd DB contention.

---

## R8: Backward Compatibility

**R8.1** The existing `benchmark_score` column semantics (higher = smarter, [0,100])
are preserved. Downstream consumers (`intelligenceComposite`, routes, model listing)
see the same column with the same range — only the derivation logic changes.

[NEW] **R8.1b** A **canary assertion** in `recomputeBenchmarkComposite()` verifies every
computed composite is in `[0, 100]` and not `NaN` or `Infinity`. If any composite
fails validation, the function logs the offending row, skips it, and continues
(rather than propagating corrupt values into the routing bandit).

**R8.2** `size_label` and `intelligence_rank` continue to be derived from
`benchmark_score` using the existing `scoreToTier()` and `scoreToIntelligenceRank()`
functions.

**R8.3** The `GET /api/benchmarks/scores` and `GET /api/benchmarks/platform/:platform`
endpoints return the same shape but now include per-source breakdowns in a new
`sources` field.

**R8.4** The static `BENCHMARK_SCORES` table in `benchmark-scores.ts` is **retained**
as a cold-start fallback (with an explanatory comment: *"Used only when all per-source
columns are NULL — provides intelligence on first boot before any live fetch succeeds"*).

[NEW] **R8.5** **Rollback migration.** The V34 down-migration is documented:
```sql
-- Restore benchmark_score from the most authoritative per-source score
UPDATE models SET benchmark_score = COALESCE(aa_score, swe_rebench_score, nim_score)
WHERE benchmark_score IS NULL OR benchmark_score = 0;

ALTER TABLE models DROP COLUMN aa_score;
ALTER TABLE models DROP COLUMN aa_score_updated;
-- ... (repeat for all V34 columns)
```

[NEW] **R8.6** **Composite version.** A `benchmark_composite_version INTEGER` column
tracks which algorithm version produced the `benchmark_score`. Bumped whenever the
composite algorithm changes. This enables debugging historical routing decisions and
A/B testing weight schemes.

---

## R9: Observability

**R9.1** Every sync logs per-source: source name, fetch duration, models updated,
errors.

**R9.2** The `/api/benchmarks/scores` response includes per-source timestamps so the
dashboard can show "last updated" per source.

[REVISED] **R9.3** Staleness info is logged continuously (not just at a 7-day boundary).
When staleness decay reduces a source's effective weight by more than 25% relative to
its base weight, a `[Benchmarks] Staleness decay applied` log entry is emitted with
the model ID, source, and effective weight.

[NEW] **R9.4** NIM speed/reliability metrics are logged alongside routing decisions
(without influencing them) to support the Phase 2 correlation analysis. Log format:
```
[Router] NIM metrics available: model=nim/deepseek-v4-flash tps=42.1 ttfb=387ms uptime=99.2% (not blended — Phase 1)
```

---

## R10: Canonical Model Identity [NEW]

**R10.1** A `canonical_model_key TEXT` column is added to the `models` table. This
stores a normalized, provider-agnostic model identifier used for matching benchmark
entries from external sources.

**R10.2** The normalization function:
```typescript
function canonicalizeModelId(modelId: string): string {
  // Lowercase, strip provider prefix slashes, collapse hyphens/underscores,
  // remove version suffixes like "-instruct", "-chat", "-it"
  return modelId
    .toLowerCase()
    .replace(/^[a-z0-9-]+\//, '')       // strip "provider/" prefix
    .replace(/[-_]/g, '-')              // normalize separators
    .replace(/-(instruct|chat|it|hf)$/, '')  // strip common suffixes
    .replace(/\.(\d+)(?=\D|$)/g, '-$1');// normalize version dots
}
```

**R10.3** All benchmark source matching (AA, SWE, NIM) uses `canonical_model_key`
instead of raw `LOWER(model_id) LIKE`. The canonical key is populated on first boot
via a migration that normalizes all existing model IDs.

**R10.4** When a new model is inserted (via auto-sync or custom provider), its
`canonical_model_key` is computed from `model_id` automatically.

**R10.5** The canonical mapping is not a perfect solution — it's a normalization
heuristic. A future task may introduce an explicit `benchmark_model_aliases` mapping
table. For now, R10.2 is sufficient and far safer than naked `LIKE`.

---

## Non-Goals

- ❌ Removing the static `BENCHMARK_SCORES` table (still useful as cold-start fallback)
- ❌ Removing AA or SWE-rebench as sources (all three are valuable)
- ❌ Adding new benchmark sources (future task, not this spec)
- ❌ Changing the routing bandit's weight presets (smartest/fastest/balanced/reliable)
- ❌ Running NIMStats locally in any form
- ❌ **NIM speed/reliability blending into the router (deferred to Phase 2 — this spec only stores + observes)**
