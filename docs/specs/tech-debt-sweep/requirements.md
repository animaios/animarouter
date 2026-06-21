# Tech Debt Sweep — Requirements

Unaddressed PR review feedback and logic bugs discovered during the phantom-exhaustion-fix review.

## Debt Items

### TD-1: Double AA benchmark fetch on boot (HIGH, PR #3 review)

**File:** `server/src/db/migrations.ts` L82-93

`migrateDbSchema` fires two concurrent async calls that both hit the AA API:

1. `fetchLiveBenchmarkScores(db)` — which calls `fetchAAScores(db)`
2. `new BenchmarkService().updateAllBenchmarkScores()` — which also calls `fetchAAScores(db)` internally

Both run concurrently (fire-and-forget). The `fetchAAScores` cache check (`Date.now() - lastFetchTime < FETCH_CACHE_TTL_MS`) only prevents re-fetches *after* a prior fetch completes. Since both calls race, neither sees the other's cache entry, and the AA API is hit **twice on every boot**.

**Fix:** Remove the standalone `fetchLiveBenchmarkScores(db)` call. Let `updateAllBenchmarkScores()` handle the full pipeline — it already calls `fetchAAScores` internally and has its own sync mutex.

---

### TD-2: NaN propagation in `stalenessDecay` and `recomputeBenchmarkComposite` (HIGH, PR #5 review)

**File:** `server/src/db/benchmark-scores.ts`

1. `stalenessDecay()` L80-86: If `updatedIso` is an invalid date string, `new Date(updatedIso).getTime()` returns `NaN`. `Date.now() - NaN` = `NaN`, propagating through `ageMs / DAY` → `Math.pow(0.5, NaN)` = `NaN`. No guard against NaN — the function returns `NaN` instead of a number.

2. `recomputeBenchmarkComposite()` L188-193: `[row.aa_score_updated, row.swe_rebench_score_updated].map(t => new Date(t).getTime())` produces NaN for invalid timestamps. `Math.max(...[NaN, valid])` = `NaN`. `new Date(NaN).toISOString()` throws `RangeError: Invalid time value` — **crashes the transaction**.

**Fix:**
- In `stalenessDecay`: add `if (!Number.isFinite(ageMs)) return 0;` after the `new Date().getTime()` call.
- In `recomputeBenchmarkComposite`: filter out NaN from the timestamps array before `Math.max`:
  ```typescript
  const timestamps = [row.aa_score_updated, row.swe_rebench_score_updated]
    .filter((t: string | null): t is string => t != null)
    .map((t: string) => new Date(t).getTime())
    .filter((t: number) => !Number.isNaN(t));
  ```

---

### TD-3: `exhaustionMap` uses `keyId` as sole key — per-model exhaustion overwritten (MEDIUM, pre-existing)

**File:** `server/src/services/key-exhaustion.ts`

`exhaustionMap` is keyed by `keyId` alone: `Map<number, {...}>`. If key #5 is exhausted on model A, and then exhausts on model B, the model A entry is silently overwritten by model B's data. The cooldown for model A persists in `rate_limit_cooldowns` but the in-memory exhaustion map only tracks model B.

The `sweepStaleExhaustion` function (introduced in phantom-exhaustion-fix) checks the `modelId` from the current map entry — so if the entry now says "model B", it checks model B's cooldown, and could clear the entry even if model A's cooldown is still active.

**Current impact is limited** — the router doesn't call `isExhausted()` (removed in PR #31). However:
- `areAllKeysExhausted` and `areAllProviderKeysExhausted` (currently dead code) would give wrong answers
- Dashboard consumers see stale exhaustion data
- Any future re-introduction of exhaustion-based routing will hit this bug

**Fix:** Change the map key to a composite `${keyId}:${modelId}` string (or a `[keyId, modelId]` tuple). Update all callers. The `clearExhausted` call (which already takes `keyId + modelId`) will work correctly. `markExhausted` already takes both. The only difficulty is `sweepStaleExhaustion` which would need to iterate both keyId and modelId combos — but that's straightforward with the composite key.

---

### TD-4: Degradation state deletion loses boost multiplier (MEDIUM, PR #22 review)

**File:** `server/src/services/degradation.ts`

Three places delete entries from `degradationStates` when penalty reaches 0:

1. `recordSuccess()` L316-318: `if (state.penalty <= 0) { degradationStates.delete(modelDbId); }`
2. `resetBoost()` L444-446: `if (state.penalty <= 0) { degradationStates.delete(modelDbId); }`
3. `evictGhostStates()` L482-485: `if (decayed < 0.01) { degradationStates.delete(modelDbId); }`

When a user sets a boost via the dashboard (e.g. 2.0 for "thumbs up"), the boost is stored in `state.boost`. If the model then recovers to penalty 0, all three paths **delete the entire state including the boost**. The boost is silently lost.

The `recordSuccess` path is especially bad: it checks `state.penalty <= 0` AFTER already setting `state.dirty = false` (it didn't set dirty because it deleted the entry). So the boost change is never flushed to DB.

**Fix:** Instead of deleting the entry when penalty reaches 0, mark it dirty and let `evictGhostStates` handle cleanup. But **preserve the entry if it has a non-default boost** (anything other than 1.0). In `evictGhostStates`, add: `if (state.boost !== 1.0) continue;`

---

### TD-5: Stale "1 RPM mode" and "normal mode" references in comments (LOW, PR #4 review)

**Files:**
- `server/src/services/key-exhaustion.ts` L5-8: comment mentions "exhausted keys are re-tried in exhaustion order" and "re-entering at the end of the queue" — this was the old 1 RPM recovery behavior, removed in PR #4.
- `server/src/services/router.ts` L654: "skipKeys accumulation gates normal-mode attempts" — "normal-mode" refers to the removed RPM mode distinction.
- `server/src/routes/proxy.ts` L1253-1254: "Mark it so the router cycles to the next key (and in 1 RPM mode, exhausted keys are re-tried in exhaustion order)" — 1 RPM mode no longer exists.

**Fix:** Update comments to remove references to removed features. The code is correct — these are misleading comments only.

---

### TD-6: `getModelForbiddenCooldownMs()` is dead code (LOW, PR #26 review)

**File:** `server/src/services/ratelimit.ts` L332-334

This function is exported but never called anywhere in the codebase. It reads the `forbidden_cooldown_hours` feature setting but has no consumer. The feature setting itself IS used by a different path (the `computeRetryCooldownMs` → `isPaymentRequired` check uses `getPaymentRequiredCooldownMs`), but `getModelForbiddenCooldownMs` itself is orphaned.

**Fix:** Remove the function. If model-forbidden cooldown logic is needed later, re-add it with a clear integration point.

---

### TD-7: `rotateArray` closure allocated on every `routeRequest` call (LOW, PR #32 review)

**File:** `server/src/services/router.ts` L626-630

```typescript
const rotateArray = <T>(arr: T[], offset: number): T[] => {
  if (arr.length === 0) return arr;
  const shift = offset % arr.length;
  return [...arr.slice(shift), ...arr.slice(0, shift)];
};
```

This function is defined *inside* `routeRequest`, creating a new closure on every routing call. Since it captures no local variables, it should be a module-level function.

**Fix:** Move `rotateArray` to module scope (before `routeRequest`).

---

### TD-8: `tok_per_sec` includes failed-request latency in denominator (MEDIUM, PR #33 review)

**File:** `server/src/routes/analytics.ts` L153-154

```sql
CASE WHEN SUM(r.latency_ms) > 0
  THEN ROUND(SUM(r.output_tokens) * 1000.0 / SUM(r.latency_ms), 1)
```

`SUM(r.latency_ms)` includes ALL requests (success + error), but `SUM(r.output_tokens)` only has tokens from successful requests (failed requests record 0 output). This inflates the denominator, deflating the tok/s metric.

Example: 1 successful request (100 tokens, 500ms) + 1 failed request (0 tokens, 3000ms) = `100 * 1000 / 3500 = 28.6 tok/s`. Actual rate for the successful request: `100 * 1000 / 500 = 200 tok/s`.

**Fix:** Filter to only successful requests in the denominator:
```sql
CASE WHEN SUM(CASE WHEN r.status = 'success' THEN r.latency_ms ELSE 0 END) > 0
  THEN ROUND(
    SUM(r.output_tokens) * 1000.0 / SUM(CASE WHEN r.status = 'success' THEN r.latency_ms ELSE 0 END),
    1
  )
  ELSE 0
END as tok_per_sec
```

---

### TD-9: `status = 'error'` keys with broken encryption waste a decrypt attempt on every request (MEDIUM, discovered during PR #34 review)

**File:** `server/src/services/router.ts` L679-686

After Fix 1 (including `'error'` in key eligibility), keys that have `status = 'error'` due to a **decrypt failure** (corrupt encrypted_key, wrong encryption key) are now visible to the router. On each `routeRequest` call, the router selects the key, attempts `decrypt()`, it fails, marks `status = 'error'` again, and `continue`s.

This is a CPU + latency hit on every routing decision. Before Fix 1, these keys were invisible. They shouldn't be routed to — a decrypt failure is a permanent key corruption, not a transient issue.

**Fix:** The decrypt-failure path should set `enabled = 0` instead of `status = 'error'`. A key with corrupt encryption can never serve traffic — disabling it prevents wasted decrypt attempts. The health checker's `checkKeyHealth` already handles decryption errors gracefully (L26-31 in `health.ts` — catches decrypt failure, sets `status = 'error'`). But once disabled, the user needs to re-enable it after fixing the encryption key.

Alternative: add a new status `'corrupt'` that is excluded from routing, distinct from `'error'` (which means "health uncertain"). This avoids disabling keys permanently.

---

### TD-10: Benchmark LIKE wildcards stripped by `applyBenchmarkScores` (MEDIUM, PR #5 review)

**File:** `server/src/db/benchmark-scores.ts` L388-391

```typescript
for (const [pattern, score] of BENCHMARK_SCORES) {
  const canonicalKey = canonicalizeModelId(pattern.replace(/%/g, ''));
  updateAAScore.run(score, new Date().toISOString(), canonicalKey, score);
}
```

`applyBenchmarkScores` strips `%` wildcards from `BENCHMARK_SCORES` patterns and then uses exact match (`WHERE canonical_model_key = ?`). But `BENCHMARK_SCORES` has wildcard patterns like `'%gemini-2.5-flash-lite%'` and `'%gpt-4o%'`. After stripping `%`, the query only matches models whose canonical key is exactly `gemini-2.5-flash-lite` or `gpt-4o` — not variants like `gemini-2.5-flash-lite-preview` or `gpt-4o-mini`.

The `fetchAAScores` function (L505-513) has the same issue — uses exact match on `canonical_model_key`.

**Fix:** Use LIKE matching with the canonicalized pattern:
```typescript
const hasWildcard = pattern.endsWith('%');
const cleanPart = pattern.replace(/%/g, '');
const canonicalKey = canonicalizeModelId(cleanPart) + (hasWildcard ? '%' : '');
// Then use: WHERE canonical_model_key LIKE ?
```

---

## Priority Matrix

| ID | Severity | Effort | Impact if unfixed |
|----|----------|--------|-------------------|
| TD-1 | HIGH | S (1 line delete) | Double API hit on every boot |
| TD-2 | HIGH | S (3 lines) | NaN crashes benchmark transaction |
| TD-8 | MEDIUM | S (1 SQL change) | Dashboard tok/s metric is wrong |
| TD-9 | MEDIUM | S (1 line change) | Wasted decrypt on every request |
| TD-10 | MEDIUM | M (refactor matching) | Benchmark scores miss model variants |
| TD-4 | MEDIUM | S (2 condition tweaks) | User boost silently lost |
| TD-3 | MEDIUM | M (key schema change) | Stale exhaustion data, future bug |
| TD-6 | LOW | S (delete function) | Dead code confusion |
| TD-7 | LOW | S (move 4 lines) | Minor perf, code hygiene |
| TD-5 | LOW | S (3 comment edits) | Misleading comments for future readers |
