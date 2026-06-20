# Spec: Latency as a First-Class Routing Axis

## Problem

TTFB (time-to-first-byte) is currently buried inside the `speed` axis at 40% weight, blended with throughput (tok/s) at 60%. Users cannot independently control *responsiveness* ("how fast does the first token arrive?") vs *throughput* ("how fast does it generate?"). These are distinct user-facing qualities: a model with great TTFB but low tok/s feels snappy for short answers, while a model with poor TTFB but high tok/s feels sluggish to start then catches up.

Additionally, `avgTtfbMs` is available from the performance API but has no dedicated column in the models table — it's invisible unless you open the edit modal or inspect the API response.

---

## Changes at a Glance

| Area | Change |
|------|--------|
| `speed` axis | Becomes **throughput-only** (`1 - exp(-tokPerSec / 60)`) |
| `latency` axis | **NEW** — `latencyScore(avgTtfbMs)`, the existing TTFB ramp extracted as standalone |
| `RoutingWeights` | Add `latency: number` (4 axes, sum to 1) |
| `RoutingScore` / `ScoredEntry.axes` | Add `latency` field |
| `BANDIT_PRESETS` | Rebalance for 4 axes |
| `FallbackPage.tsx` | Add TTFB column + 4th weight slider |
| `routingSchema` | Validate `latency` weight |
| `getCustomWeights` / `setCustomWeights` | 4-field parse/serialize with backward compat |

No DB migration needed — `ttfb_ms` already exists in `requests`, `avgTtfbMs` already in `model_stats_temp`.

---

## 1. `server/src/services/scoring.ts`

### 1a. `RoutingWeights` — add `latency`

```typescript
export interface RoutingWeights {
  reliability: number;
  speed: number;
  intelligence: number;
  latency: number;       // NEW
}
```

### 1b. `BANDIT_PRESETS` — rebalance for 4 axes

```typescript
export const BANDIT_PRESETS: Record<Exclude<RoutingStrategy, 'priority' | 'custom'>, RoutingWeights> = {
  balanced:  { reliability: 0.40, speed: 0.20, intelligence: 0.20, latency: 0.20 },
  smartest:  { reliability: 0.30, speed: 0.10, intelligence: 0.45, latency: 0.15 },
  fastest:   { reliability: 0.25, speed: 0.30, intelligence: 0.10, latency: 0.35 },
  reliable:  { reliability: 0.60, speed: 0.10, intelligence: 0.15, latency: 0.15 },
};
```

Rationale:
- **balanced**: even spread, slight reliability edge (unchanged philosophy).
- **smartest**: intelligence still dominates, latency gets a small edge over raw speed because smart models tend to have higher TTFB and shouldn't be entirely penalized.
- **fastest**: both throughput (speed) and responsiveness (latency) are heavily weighted — this is the "everything fast" preset.
- **reliable**: reliability dominates; the remaining 40% splits evenly among the other three.

### 1c. `speedScore()` — remove TTFB blending, throughput-only

```typescript
// Remove THROUGHPUT_WEIGHT and TTFB_WEIGHT constants (no longer needed here).

export function speedScore(tokPerSec: number): number {
  if (tokPerSec <= 0) return SPEED_PRIOR;
  return throughputScore(tokPerSec);
}
```

The old `ttfbMs` parameter is removed. `speedScore` now returns a pure throughput score.

### 1d. NEW: `latencyScore()` — extracted TTFB ramp

```typescript
// Reuses the existing TTFB_BEST_MS (300) and TTFB_WORST_MS (5000) constants.
// Optimistic prior so unmeasured models still get explored on the latency axis.
export const LATENCY_PRIOR = 0.6;

export function latencyScore(avgTtfbMs: number | null): number {
  if (avgTtfbMs === null) return LATENCY_PRIOR;
  return ttfbScore(avgTtfbMs);  // same ramp: 1.0 at ≤300ms → 0.0 at ≥5000ms
}
```

`ttfbScore()` stays as-is (internal function, same formula). `latencyScore()` is the public wrapper that adds the null→prior fallback.

### 1e. NEW: `heavyWeightedLatencyScore()` — real-data blend

Mirrors the existing `heavyWeightedSpeedScore` pattern: logistic blend of real TTFB data vs manual prior, driven by request count confidence.

```typescript
export function heavyWeightedLatencyScore(
  avgTtfbMs: number | null,
  totalRequests: number,
  defaultLatencyScore: number,
): number {
  if (avgTtfbMs === null && totalRequests <= 0) return defaultLatencyScore;
  const realScore = latencyScore(avgTtfbMs);
  const confidence = realDataConfidence(totalRequests);
  const realWeight = confidence * REAL_SPEED_MAX_WEIGHT;  // reuse same constants
  const defaultWeight = 1 - realWeight;
  return realWeight * realScore + defaultWeight * defaultLatencyScore;
}
```

### 1f. `heavyWeightedSpeedScore()` — drop `ttfbMs` param

```typescript
export function heavyWeightedSpeedScore(
  tokPerSec: number,
  totalRequests: number,
  defaultSpeedScore: number,
): number {
  if (tokPerSec <= 0 && totalRequests <= 0) return defaultSpeedScore;
  const realScore = speedScore(tokPerSec);  // throughput only now
  const confidence = realDataConfidence(totalRequests);
  const realWeight = confidence * REAL_SPEED_MAX_WEIGHT;
  const defaultWeight = 1 - realWeight;
  return realWeight * realScore + defaultWeight * defaultSpeedScore;
}
```

### 1g. `ScoreInputs` — add `latency`

```typescript
export interface ScoreInputs {
  reliability: number;
  speed: number;
  intelligence: number;
  latency: number;  // NEW
  degradationFactor: number;
}
```

### 1h. `combineScore()` — add `latency` term

```typescript
export function combineScore(inputs: ScoreInputs, weights: RoutingWeights): number {
  const wSum = weights.reliability + weights.speed + weights.intelligence + weights.latency || 1;
  const base =
    (weights.reliability * inputs.reliability +
      weights.speed * inputs.speed +
      weights.intelligence * inputs.intelligence +
      weights.latency * inputs.latency) / wSum;
  return base * inputs.degradationFactor;
}
```

### 1i. Latency prior from `size_label`

When no real TTFB data exists, derive an optimistic TTFB estimate from the model's size tier:

```typescript
const TTFB_PRIOR_MS: Record<string, number> = {
  Small: 200,
  Medium: 400,
  Large: 800,
  Frontier: 500,
  Custom: 500,
};

export function latencyCompositeFromSize(sizeLabel: string): number {
  const ttfbMs = TTFB_PRIOR_MS[sizeLabel] ?? 500;
  return ttfbScore(ttfbMs);
}
```

This produces a [0,1] default latency score that min-max normalizes alongside real-data scores.

---

## 2. `server/src/services/router.ts`

### 2a. `ScoredEntry.axes` — add `latency`

```typescript
interface ScoredEntry {
  axes: { reliability: number; speed: number; intelligence: number; latency: number };
  degradationFactor: number;
  boost: number;
  score: number;
}
```

### 2b. `scoreChainEntry()` — compute latency axis

The function gains `latencyMin` / `latencyMax` parameters for min-max normalization of the manual prior (same pattern as speed and intelligence):

```typescript
function scoreChainEntry(
  entry: ChainRow,
  weights: RoutingWeights,
  intelMin: number, intelMax: number,
  speedMin: number, speedMax: number,
  latencyMin: number, latencyMax: number,  // NEW
  sampled: boolean,
): ScoredEntry {
```

New latency scoring block (after speed, before intelligence):

```typescript
  // Latency axis: TTFB, blended with manual size-based prior.
  const latencyComposite = latencyCompositeFromSize(entry.size_label);
  const defaultLatency = latencyMax > latencyMin
    ? (latencyComposite - latencyMin) / (latencyMax - latencyMin)
    : 1;

  const latency = heavyWeightedLatencyScore(
    stats?.avgTtfbMs ?? null,
    totalRequests,
    defaultLatency,
  );
```

Update the `combineScore` call:

```typescript
  const baseScore = combineScore(
    { reliability, speed, intelligence, latency, degradationFactor }, weights,
  );
```

Update the return:

```typescript
  return { axes: { reliability, speed, intelligence, latency }, degradationFactor, boost, score };
```

### 2c. `speedScore` call in `scoreChainEntry` — drop `ttfbMs`

```typescript
  const speed = heavyWeightedSpeedScore(
    stats?.tokPerSec ?? 0,
    totalRequests,
    defaultSpeed,
  );
  // Note: stats?.avgTtfbMs is no longer passed to speedScore — it feeds latencyScore instead.
```

### 2d. `orderChain()` — compute latency composites for min-max

After the speed composites block, add:

```typescript
  // Latency composites for min-max normalization
  const latencyComposites = chain.map(e => latencyCompositeFromSize(e.size_label));
  const latencyMin = latencyComposites.length ? Math.min(...latencyComposites) : 0;
  const latencyMax = latencyComposites.length ? Math.max(...latencyComposites) : 0;
```

Pass them to `scoreChainEntry`:

```typescript
  return chain
    .map(e => ({ e, s: scoreChainEntry(e, weights, intelMin, intelMax, speedMin, speedMax, latencyMin, latencyMax, true).score }))
```

### 2e. `getCustomWeights()` — backward-compat 3-axis → 4-axis

```typescript
export function getCustomWeights(): RoutingWeights {
  const raw = getSetting(CUSTOM_WEIGHTS_KEY);
  if (raw) {
    try {
      const w = JSON.parse(raw) as Partial<RoutingWeights>;
      const reliability = w.reliability ?? 0;
      const speed = w.speed ?? 0;
      const intelligence = w.intelligence ?? 0;
      const latency = w.latency ?? 0.20;  // default for old 3-axis stored weights
      if (
        [reliability, speed, intelligence, latency].every(v => Number.isFinite(v) && v >= 0) &&
        reliability + speed + intelligence + latency > 0
      ) {
        return { reliability, speed, intelligence, latency };
      }
    } catch { /* corrupt setting → fall through to default */ }
  }
  return { ...BANDIT_PRESETS.balanced };
}
```

### 2f. `setCustomWeights()` — 4-field serialize

```typescript
export function setCustomWeights(weights: RoutingWeights): void {
  const { reliability, speed, intelligence, latency } = weights;
  if (![reliability, speed, intelligence, latency].every(v => Number.isFinite(v) && v >= 0)) {
    throw new Error('Custom weights must be non-negative numbers');
  }
  const sum = reliability + speed + intelligence + latency;
  if (sum <= 0) {
    throw new Error('Custom weights must not all be zero');
  }
  setSetting(CUSTOM_WEIGHTS_KEY, JSON.stringify({
    reliability: reliability / sum,
    speed: speed / sum,
    intelligence: intelligence / sum,
    latency: latency / sum,
  }));
}
```

### 2g. `getRoutingScores()` — add latency to returned scores

The `/api/fallback/routing` endpoint returns per-model scores. Add `latency` to each score object so the client can display it.

---

## 3. `server/src/routes/fallback.ts`

### 3a. `routingSchema` — add `latency` to weights

```typescript
const routingSchema = z.object({
  strategy: z.enum(['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']),
  weights: z.object({
    reliability: z.number().min(0).max(1),
    speed: z.number().min(0).max(1),
    intelligence: z.number().min(0).max(1),
    latency: z.number().min(0).max(1),  // NEW
  }).refine(w => w.reliability + w.speed + w.intelligence + w.latency > 0, {
    message: 'weights must not all be zero',
  }).optional(),
});
```

---

## 4. `client/src/pages/FallbackPage.tsx`

### 4a. Types — add `latency`

```typescript
type RoutingWeights = { reliability: number; speed: number; intelligence: number; latency: number }

interface RoutingScore {
  modelDbId: number
  reliability: number
  speed: number
  intelligence: number
  latency: number    // NEW
  boost: number
  score: number
  totalRequests: number
}
```

### 4b. `STRATEGIES` — update blurbs to mention latency

```typescript
const STRATEGIES: { key: RoutingStrategy; label: string; blurb: string }[] = [
  { key: 'priority', label: 'Manual', blurb: 'Route in the exact order you set below. Drag the handles to reorder. No scoring; the chain is followed top-to-bottom.' },
  { key: 'balanced', label: 'Balanced', blurb: 'Reliability leads (40%), with speed, intelligence and latency weighted equally (20% each). A sensible all-round default.' },
  { key: 'smartest', label: 'Smartest', blurb: 'Prefer the most capable model that still works. Intelligence 45%, reliability 30%, latency 15%, speed 10%.' },
  { key: 'fastest', label: 'Fastest', blurb: 'Prefer the fastest, most responsive model. Latency 35%, speed 30%, reliability 25%, intelligence 10%.' },
  { key: 'reliable', label: 'Most reliable', blurb: 'Maximize success rate above all. Reliability 60%, intelligence 15%, latency 15%, speed 10%.' },
  { key: 'custom', label: 'Custom', blurb: 'Set your own balance of reliability, speed, intelligence and latency with sliders. Same engine as the presets, just your weights.' },
]
```

### 4c. `WEIGHT_AXES` — add 4th entry

```typescript
const WEIGHT_AXES: { key: keyof RoutingWeights; label: string; color: string }[] = [
  { key: 'reliability', label: 'Reliability', color: '#22c55e' },
  { key: 'speed', label: 'Speed', color: '#3b82f6' },
  { key: 'intelligence', label: 'Intelligence', color: '#a855f7' },
  { key: 'latency', label: 'Latency', color: '#f59e0b' },  // amber
]
```

### 4d. `CustomWeightsPopover` — extend to 4 axes

The component already iterates `WEIGHT_AXES.map(...)` and works off `keyof RoutingWeights`, so it generalizes automatically. The only manual change:

- `fromSaved()`: add `latency: Math.round(w.latency * 100)`
- `apply()`: add `latency: values.latency / 100`
- `sum`: add `values.latency` to the sum expression

### 4e. Models table — add TTFB column

Add a new "TTFB" column between the Speed and Intelligence columns. It shows `avgTtfbMs` from the performance data, formatted as:

- **Value**: `${avgTtfbMs}ms` if data exists, `—` if null
- **Color bar**: Same gradient as speed (green ≤300ms → red ≥5000ms), using the amber `#f59e0b` accent
- **Tooltip**: "Time to first byte (decay-weighted average from last 7 days)"

Data source: the `/api/fallback/performance` endpoint already returns `actualAvgTtfbMs` per model. The `FallbackPage` component already fetches this as `performanceData` and merges it into `entriesWithPerformance`. The `Row` type (or `RowContent` component) just needs to render it.

### 4f. Routing score display — add latency dot

The per-model score display currently shows colored dots for reliability, speed, intelligence. Add a 4th amber dot for latency, using the same `latencyScore()` formula (or the value returned from `/api/fallback/routing` scores).

---

## 5. `shared/types.ts` (if applicable)

If `RoutingWeights` or `RoutingScore` is mirrored in `shared/types.ts`, add the `latency` field there too so client and server share the same interface.

---

## Migration / Backward Compatibility

| Scenario | Handling |
|----------|----------|
| Old 3-axis custom weights in DB | `getCustomWeights()` defaults `latency: 0.20` when field is missing |
| Old server, new client | Not handled (localhost-only per decision) |
| Existing `requests.ttb_ms` data | Already collected; no schema change needed |
| `model_stats_temp.avgTtfbMs` | Already computed; no schema change needed |
| `BANDIT_PRESETS` change | Presets are in-memory constants; no persisted preset data to migrate |

No `CURRENT_DATA_VERSION` bump needed — no data reset required.

---

## File-by-File Touch List

| File | Scope |
|------|-------|
| `server/src/services/scoring.ts` | Add `latency` to `RoutingWeights`, `ScoreInputs`; add `latencyScore`, `heavyWeightedLatencyScore`, `latencyCompositeFromSize`, `TTFB_PRIOR_MS`, `LATENCY_PRIOR`; make `speedScore` throughput-only; update `combineScore`; update `BANDIT_PRESETS` |
| `server/src/services/router.ts` | Add `latency` to `ScoredEntry.axes`, `scoreChainEntry` (new params + latency block), `orderChain` (latency composites + min-max), `getCustomWeights` (4-field + backward compat), `setCustomWeights` (4-field); update `getRoutingScores` return shape; add `latency` to `RoutingScore` interface |
| `server/src/routes/fallback.ts` | Add `latency` to `routingSchema` |
| `client/src/pages/FallbackPage.tsx` | Add `latency` to `RoutingWeights`, `RoutingScore`; update `STRATEGIES`, `WEIGHT_AXES`; extend `CustomWeightsPopover`; add TTFB column to models table; add latency score dot; remove inline TTFB display from Speed column; update strategy weights header display, page description, and Score tooltip to mention latency |
| `server/src/__tests__/services/scoring.test.ts` | Update `speedScore()` calls (drop `ttfbMs` param); remove TTFB-blending test (now covered by `latencyScore`); add `latency` to all `ScoreInputs` in `combineScore` tests; update preset weight-sum assertion for 4 axes; add `latencyScore` test cases |
| `server/src/__tests__/services/router-bandit.test.ts` | Add `latency` field to all `setCustomWeights` / `getCustomWeights` assertions; update `toEqual` expectations for 4-axis weights |

---

## Testing Checklist

- [ ] `npm run test -w server` — scoring and router tests pass
- [ ] `npx tsc --noEmit` (both workspaces) — no type errors
- [ ] `speedScore()` without `ttfbMs` returns same throughput-only value
- [ ] `latencyScore(null)` returns `LATENCY_PRIOR` (0.6)
- [ ] `latencyScore(300)` returns 1.0; `latencyScore(5000)` returns 0.0
- [ ] `combineScore` with 4-axis weights produces correct convex combination
- [ ] `getCustomWeights()` on old 3-axis JSON returns `latency: 0.20`
- [ ] `setCustomWeights({ 0.4, 0.2, 0.2, 0.2 })` stores normalized 4-field JSON
- [ ] Manual: dashboard shows 4 weight sliders; presets show 4-axis values
- [ ] Manual: TTFB column displays ms values with color bar
- [ ] Manual: `fastest` preset prioritizes models with low TTFB + high tok/s

---

## Open Items

1. **`LATENCY_PRIOR` value**: Set to 0.6 (same as `SPEED_PRIOR`) so unmeasured models are explored. Tunable if latency axis turns out to over-explore.
2. **TTFB column sorting**: Not in scope for this spec (adding sort-by-TTFB to the column header is a natural follow-up).
3. **`speed_rank` → latency prior**: Currently `latencyCompositeFromSize` uses `sizeLabel` only. `speed_rank` is not used because it's a within-provider rank for overall speed, not specifically TTFB. If a per-model "latency rank" is added later, it can feed the prior.

---

## Review Notes (Implementation Gaps Found)

1. **`shared/types.ts`**: `RoutingWeights` and `RoutingScore` are NOT mirrored in shared types — no change needed there.
2. **Inline TTFB removal**: The existing Speed column in `FallbackPage.tsx` renders TTFB inline (`${avgTtfbMs}ms ttfb` on hover). This must be removed when the dedicated TTFB column is added to avoid redundancy.
3. **Strategy weights header**: The `{routing.weights && ...}` block at the top of the strategy section displays `reliability X% · speed Y% · intelligence Z%` — needs `latency Z%` appended.
4. **Page description**: `PageHeader` description says "reliability, speed and intelligence" — needs "latency" added.
5. **Score tooltip**: Says "Final routing score across reliability, speed and intelligence" — needs updating.
6. **Test breakage**: `scoring.test.ts` has 6 tests using the old `speedScore(tokPerSec, ttfbMs)` signature; `router-bandit.test.ts` has 5 tests with hardcoded 3-axis weight assertions. All must be updated.
