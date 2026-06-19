# Dynamic Degradation System — Design Document

## 1. Architecture Overview

The degradation system introduces a new **Degradation Engine** module that replaces the current flat 429-penalty system (`router.ts` lines 111-187). It lives as a new file `server/src/services/degradation.ts` and integrates into the existing routing pipeline at exactly the same junction where `rateLimitFactor()` + `getPenalty()` currently operate.

```
                        ┌──────────────────────────┐
                        │     routeRequest()        │
                        │     (router.ts)           │
                        └────────────┬─────────────┘
                                     │
                                     ▼
                        ┌──────────────────────────┐
                        │     orderChain()          │
                        │  ┌──────────────────────┐│
                        │  │  scoreChainEntry()   ││
                        │  │  ┌──────────────────┐││
                        │  │  │  combineScore()  │││
                        │  │  │  ┌──────────────┐│││
                        │  │  │  │ NEW:          ││││
                        │  │  │  │ degradation   ││││
                        │  │  │  │ _factor()     ││││
                        │  │  │  └──────┬───────┘│││
                        │  │  └─────────┼────────┘││
                        │  └────────────┼─────────┘│
                        └───────────────┼──────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   ▼                   │
                    │  ┌────────────────────────────┐       │
                    │  │     Degradation Engine     │       │
                    │  │     (degradation.ts)       │       │
                    │  │                            │       │
                    │  │  ┌──────────────────────┐  │       │
                    │  │  │  In-Memory State     │  │       │
                    │  │  │  Map<modelDbId, {...}>│  │       │
                    │  │  └──────────────────────┘  │       │
                    │  │                            │       │
                    │  │  ┌──────────────────────┐  │       │
                    │  │  │  DB Persistence       │  │       │
                    │  │  │  model_degradation    │  │       │
                    │  │  │  (periodic flush)     │  │       │
                    │  │  └──────────────────────┘  │       │
                    │  │                            │       │
                    │  │  recordFailure()           │       │
                    │  │  recordSuccess()           │       │
                    │  │  getPenalty()              │       │
                    │  │  getDegradationFactor()    │       │
                    │  │  getDisplayTier()          │       │
                    │  │  getAllStatesRaw()          │       │
                    │  │  getAllStatesView()        │       │
                    │  └────────────────────────────┘       │
                    │                                       │
                    │  ┌────────────────────────────┐       │
                    │  │  proxy.ts (call sites)     │       │
                    │  │                            │       │
                    │  │  On failure:               │       │
                    │  │    classifyError(err)      │       │
                    │  │    degradation.recordFail()│       │
                    │  │                            │       │
                    │  │  On success:               │       │
                    │  │    degradation.recordOK()  │       │
                    │  └────────────────────────────┘       │
                    └───────────────────────────────────────┘
```

## 2. Core Data Model

### 2.1 DegradationState

```typescript
interface DegradationState {
  /** Accumulated penalty (0 = healthy, MAX_PENALTY = dead). */
  penalty: number;

  /** Severity tier that drove the most recent half-life (for half-life ratchet). */
  tier: 'minor' | 'major' | 'critical';

  /** Consecutive failure count (all tiers) since last success. Reset on success. */
  consecutiveHits: number;

  /** Consecutive MAJOR failure count since last success or minor failure. Reset on success or minor hit. */
  consecutiveMajorHits: number;

  /** Timestamp (ms) of the most recent failure. Used for time-decay. Always a valid number. */
  lastHitAt: number;

  /** Half-life (ms) currently in effect. Ratchets up, resets to minor only at penalty=0. */
  halfLifeMs: number;

  /** Dirty flag — true if state changed since last DB flush. */
  dirty: boolean;
}
```

Note: `lastPersistedAt` removed — replaced by `dirty: boolean` which is simpler and more reliable for tracking which states need flushing.

### 2.2 Database Table

```sql
CREATE TABLE IF NOT EXISTS model_degradation (
  model_db_id   INTEGER PRIMARY KEY,
  penalty       REAL    NOT NULL DEFAULT 0,
  tier          TEXT    NOT NULL DEFAULT 'minor',
  consecutive   INTEGER NOT NULL DEFAULT 0,
  consecutive_major INTEGER NOT NULL DEFAULT 0,
  last_hit_at   INTEGER,          -- Unix ms timestamp, NULL if never hit
  half_life_ms  INTEGER NOT NULL DEFAULT 120000,  -- minor default
  FOREIGN KEY (model_db_id) REFERENCES models(id) ON DELETE CASCADE
);
```

### 2.3 Configuration

```typescript
interface DegradationConfig {
  minor:  { weight: number; halfLifeMs: number };
  major:  { weight: number; halfLifeMs: number };
  critical: { weight: number; halfLifeMs: number; consecutiveThreshold: number };
  compoundFactor: number;
  successRecovery: number;
  dampStrength: number;
  maxPenalty: number;
}
```

Defaults are populated from env vars (see FR-7 in requirements) and frozen at server start.

### 2.4 Provider Error Type

For robust error classification, the system accepts a richer error type:

```typescript
interface ProviderError {
  /** HTTP status code if available (e.g., 429, 503). */
  status?: number;
  /** Original error for message-based fallback classification. */
  cause: Error;
}
```

The `classifyError` function accepts either a `ProviderError` or a plain `Error`. When a `status` numeric field is present (directly on the error or via `err.status` / `err.response?.status`), that takes priority over message matching.

## 3. Algorithm Details

### 3.1 `classifyError(err): 'minor' | 'major' | null`

Classifies a provider error into a degradation tier. Returns `null` if the error is non-retryable or non-degrading.

```typescript
function classifyError(err: any): 'minor' | 'major' | null {
  const msg = (err.message ?? '').toLowerCase();

  // ── Primary: numeric status code (most reliable) ──────────────────────
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (typeof status === 'number') {
    if (status === 429) {
      // Hard quota vs soft rate limit
      if (msg.includes('quota') || msg.includes('insufficient')) return null;
      return 'minor';
    }
    if (status === 402) return 'minor';
    if (status >= 500 && status < 600) return 'major';
    // 4xx client errors (including 404, 403) → non-degrading
    return null;
  }

  // ── Fallback: message-based classification ───────────────────────────

  // Client-side abort → non-degrading
  if (err.name === 'AbortError' || msg.includes('abort')) return null;

  // Hard quota in message → non-degrading
  if (msg.includes('quota') || msg.includes('insufficient')) return null;

  // 429 / rate limit → minor (soft only; quota already excluded)
  if (msg.includes('429') || msg.includes('rate limit')) return 'minor';

  // 402 → minor
  if (msg.includes('402') || msg.includes('payment required')) return 'minor';

  // 5xx → major
  if (msg.includes('500') || msg.includes('502') || msg.includes('503')
      || msg.includes('504') || msg.includes('server error')
      || msg.includes('service unavailable')) return 'major';

  // Network / timeout / TLS → major
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('econnreset')
      || msg.includes('etimedout') || msg.includes('enotfound') || msg.includes('eproto')
      || msg.includes('econnabort') || msg.includes('fetch failed')) return 'major';

  // Unknown → non-degrading (don't penalize on unclassifiable errors)
  return null;
}
```

### 3.2 `recordFailure(modelDbId, tier)`

Called from `proxy.ts` after any retryable failure. Mutates in-memory state. Uses the **lazy-read decay model**: mutations apply time-decay to the stored penalty, then apply their change — re-anchoring the stored penalty to the current time.

```typescript
function recordFailure(modelDbId: number, tier: 'minor' | 'major'): void {
  const state = getOrCreateState(modelDbId);
  const cfg = getConfig();
  const now = Date.now();

  // 1. Apply time-decay to STORED penalty (re-anchor to now)
  const elapsed = now - state.lastHitAt;
  state.penalty = applyDecay(state.penalty, elapsed, state.halfLifeMs);
  state.penalty = Math.max(0, state.penalty);

  // 2. Increment consecutive counters
  state.consecutiveHits++;
  if (tier === 'major') {
    state.consecutiveMajorHits++;
  } else {
    // Minor failure breaks the "consecutive major" streak
    state.consecutiveMajorHits = 0;
  }

  // 3. Determine effective tier for this hit
  let effectiveTier = tier;
  if (tier === 'major' && state.consecutiveMajorHits >= cfg.critical.consecutiveThreshold) {
    effectiveTier = 'critical';
  }

  // 4. Compute severity weight for this hit
  const weight = cfg[effectiveTier].weight;

  // 5. Compound: exponent = max(0, consecutiveHits - 1)
  const exponent = Math.max(0, state.consecutiveHits - 1);
  const compound = Math.pow(cfg.compoundFactor, exponent);
  const increment = weight * compound;

  // 6. Accumulate, clamped
  state.penalty = Math.min(cfg.maxPenalty, state.penalty + increment);

  // 7. Ratchet half-life up (never down)
  const newHalfLife = cfg[effectiveTier].halfLifeMs;
  if (newHalfLife > state.halfLifeMs) {
    state.halfLifeMs = newHalfLife;
  }
  state.tier = effectiveTier;
  state.lastHitAt = now;
  state.dirty = true;

  // 8. Emit event
  publish({
    type: 'degradation.hit',
    modelDbId, tier: effectiveTier, penalty: state.penalty,
    consecutive: state.consecutiveHits, consecutiveMajor: state.consecutiveMajorHits,
    at: now,
  });
}
```

### 3.3 `recordSuccess(modelDbId)`

Called from `proxy.ts` on every successful response.

```typescript
function recordSuccess(modelDbId: number): void {
  const state = degradationStates.get(modelDbId);
  if (!state || state.penalty <= 0) return;

  const cfg = getConfig();
  const now = Date.now();

  // 1. Apply time-decay to STORED penalty (re-anchor to now)
  const elapsed = now - state.lastHitAt;
  state.penalty = applyDecay(state.penalty, elapsed, state.halfLifeMs);
  state.penalty = Math.max(0, state.penalty);

  // 2. Recovery: floor() for deterministic integer steps
  const recovery = Math.min(state.penalty, Math.max(1, Math.floor(state.penalty * cfg.successRecovery)));
  state.penalty = Math.max(0, state.penalty - recovery);

  // 3. Reset both consecutive counters
  state.consecutiveHits = 0;
  state.consecutiveMajorHits = 0;

  // 4. If penalty is low enough, snap to zero and reset half-life
  if (state.penalty < 1) {
    state.penalty = 0;
    state.tier = 'minor';        // Internal tier tracks last-applied tier
    state.halfLifeMs = cfg.minor.halfLifeMs;  // Only time half-life decreases
  }

  // 5. Clean up zero-penalty entries from memory
  if (state.penalty <= 0) {
    degradationStates.delete(modelDbId);
  } else {
    state.dirty = true;
  }

  // 6. Emit event
  publish({
    type: 'degradation.recovery',
    modelDbId, penalty: state.penalty, at: now,
  });
}
```

### 3.4 `applyDecay(penalty, elapsedMs, halfLifeMs)`

Pure exponential decay with float snapping — no side effects.

```typescript
function applyDecay(penalty: number, elapsedMs: number, halfLifeMs: number): number {
  if (penalty <= 0 || elapsedMs <= 0) return penalty;
  const halfLives = elapsedMs / halfLifeMs;
  const result = penalty * Math.pow(0.5, halfLives);
  return result < 0.01 ? 0 : result;  // Snap to absolute zero below threshold
}
```

### 3.5 `getPenalty(modelDbId): number`

Pure lazy read — returns decayed value without mutating stored state.

```typescript
function getPenalty(modelDbId: number): number {
  const state = degradationStates.get(modelDbId);
  if (!state) return 0;
  const elapsed = Date.now() - state.lastHitAt;
  return applyDecay(state.penalty, elapsed, state.halfLifeMs);
}
```

### 3.6 `getDegradationFactor(modelDbId): number`

The guardrail multiplier for `combineScore`.

```typescript
function getDegradationFactor(modelDbId: number): number {
  const penalty = getPenalty(modelDbId);
  if (penalty <= 0) return 1;
  const cfg = getConfig();
  const normalized = penalty / cfg.maxPenalty;
  return 1 / (1 + normalized * normalized * cfg.dampStrength);
}
```

### 3.7 `getDisplayTier(penalty): string`

Maps current penalty to a display-friendly tier (FR-6 Tier Display Policy).

```typescript
function getDisplayTier(penalty: number): 'healthy' | 'minor' | 'major' | 'critical' {
  if (penalty <= 0) return 'healthy';
  if (penalty <= 10) return 'minor';
  if (penalty <= 30) return 'major';
  return 'critical';
}
```

### 3.8 `getAllStatesRaw()` and `getAllStatesView()`

Split storage vs. view (per ChatGPT's recommendation):

```typescript
/** Returns raw internal states (for persistence). No decay applied. */
function getAllStatesRaw(): Map<number, DegradationState> {
  return new Map(degradationStates);
}

/** Returns decayed view of states (for dashboard/API). Penalty is time-decayed. */
function getAllStatesView(): Map<number, DegradationState & { displayTier: string }> {
  const result = new Map();
  for (const [id, state] of degradationStates) {
    const elapsed = Date.now() - state.lastHitAt;
    const penalty = applyDecay(state.penalty, elapsed, state.halfLifeMs);
    result.set(id, {
      ...state,
      penalty,
      displayTier: getDisplayTier(penalty),
    });
  }
  return result;
}
```

### 3.9 Worked Example: A Model in Trouble

Timeline for a model that starts healthy and gets progressively worse (corrected with formula values):

| Time | Event | Cons. | ConsMaj | Penalty | Internal Tier | Half-Life | Factor |
|------|-------|-------|---------|---------|---------------|-----------|--------|
| T+0m | 429 (minor) | 1 | 0 | 1.0 | minor | 2m | 0.9999 |
| T+1m | 503 (major) | 2 | 1 | 0.70 + 3.0×1.5¹ = 5.2 | major | 15m | 0.889 |
| T+1.5m | 503 (major) | 3 | 2 | 5.2→5.08 + 3.0×1.5² = 11.8 | major | 15m | 0.588 |
| T+2m | 503 (major) — now consecutiveMajor=3 ≥ threshold → critical | 4 | 3 | 11.8→11.5 + 6.0×1.5³ = 31.8 | critical | 60m | 0.144 |
| T+2.5m | 503 (critical) | 5 | 4 | 31.8→31.2 + 6.0×1.5⁴ = 61.5 | critical | 60m | 0.042 |
| T+3m | 503 (critical) | 6 | 5 | 61.5→60.3 + 6.0×1.5⁵ = 111.6→**100** | critical | 60m | 0.020 |
| T+5m | Success | 0 | 0 | 100→decay→96.4-30=**66.4→floor→66** | critical | 60m | 0.099 |
| T+8m | Success | 0 | 0 | 66→decay→64.1-19=**45.1→floor→45** | critical | 60m | 0.168 |
| T+63m | (idle) | 0 | 0 | 45→decay(1HL)→22.5 | critical | 60m | 0.200 |
| T+123m | (idle) | 0 | 0 | 22.5→decay(2HL)→11.25 | critical | 60m | 0.345 |

Note: After first success at T+5m, `recordSuccess` applies `floor(96.4 × 0.3) = floor(28.92) = 28`, not 30. This is the deterministic recovery from FR-4. The factor values are computed using the corrected formula `1/(1 + (p/100)² × 50)`.

## 4. Integration Points

### 4.1 Changes to `scoring.ts`

**DELETE**: `rateLimitFactor()`, `MAX_PENALTY`, `RATE_LIMIT_MAX_DAMP`, `PENALTY_PER_429`, `DECAY_INTERVAL_MS`, `DECAY_AMOUNT`

**ADD**: `import { getDegradationFactor } from './degradation.js'`

**MODIFY**: `combineScore()` — accept `degradationFactor` instead of `rateLimit`:

```typescript
export interface ScoreInputs {
  reliability: number;
  speed: number;
  intelligence: number;
  degradationFactor: number;  // was: rateLimit: number
}

export function combineScore(inputs: ScoreInputs, weights: RoutingWeights): number {
  const wSum = weights.reliability + weights.speed + weights.intelligence || 1;
  const base =
    (weights.reliability * inputs.reliability +
     weights.speed * inputs.speed +
     weights.intelligence * inputs.intelligence) / wSum;
  return base * inputs.degradationFactor;
}
```

### 4.2 Changes to `router.ts`

**DELETE**: `rateLimitPenalties` Map, `recordRateLimitHit()`, `clearRateLimitPenalty()`, `recordSuccess()`, `getPenalty()`, `getAllPenalties()`, `PENALTY_PER_429`, `DECAY_INTERVAL_MS`, `DECAY_AMOUNT`

**ADD**: `import { getDegradationFactor, getPenalty, getAllStatesView, initDegradation, recordFailure, recordSuccess } from './degradation.js'`

**MODIFY**: `scoreChainEntry()` — replace `rateLimitFactor(getPenalty(...))` with `getDegradationFactor(entry.model_db_id)`:

```typescript
function scoreChainEntry(...): ScoredEntry {
  // ... reliability, speed, intelligence unchanged ...

  const degradationFactor = getDegradationFactor(entry.model_db_id);

  const score = combineScore(
    { reliability, speed, intelligence, degradationFactor },
    weights,
  );
  return { axes: { reliability, speed, intelligence }, degradationFactor, score };
}
```

**RENAME**: `ScoredEntry.rateLimit` → `ScoredEntry.degradationFactor`

**MODIFY**: `getAllPenalties()` → re-export as wrapper calling `getAllStatesView()` with backward-compat shape (until cleanup task).

### 4.3 Changes to `proxy.ts`

**DELETE**: `import { recordRateLimitHit, recordSuccess } from '../services/router.js'`

**ADD**: `import { recordFailure, recordSuccess, classifyError } from '../services/degradation.js'`

**MODIFY**: All call sites that currently call `recordRateLimitHit(route.modelDbId)` — replace with:

```typescript
const tier = classifyError(err);
if (tier) {
  recordFailure(route.modelDbId, tier);
}
```

Note: `classifyError` now prioritizes `err.status` numeric field over message matching, so if the provider adapter sets `err.status = 503`, classification is immediate and reliable.

### 4.4 Changes to `fallback.ts` (Dashboard API)

**MODIFY**: `GET /api/fallback/routing` response — `rateLimit` field becomes `degradationFactor`.

**ADD**: `GET /api/fallback/degradation` endpoint returning:
- Decay-adjusted penalty
- Display tier (from `getDisplayTier()`, not internal tier)
- `consecutiveHits` and `consecutiveMajorHits`
- `estimatedRecoveryMs` — `penalty > 1 ? halfLifeMs * Math.log2(penalty) : null` (guard: null when penalty ≤ 1)

**FIX**: `estimatedRecoveryMs` must use `penalty > 1` (not `> 0`) to avoid negative values from `Math.log2(penalty)` when penalty is between 0 and 1.

### 4.5 Changes to `migrations.ts`

**ADD**: Migration to create `model_degradation` table (with `consecutive_major` column).

## 5. Persistence Strategy

The in-memory `Map<modelDbId, DegradationState>` is the source of truth during runtime. Persistence is **periodic only** (no per-mutation writes on the hot path):

1. **Startup**: Load all rows from `model_degradation`. Apply time-decay to each row's penalty before loading into memory. Skip rows where the decayed penalty < 0.01 (dead data; also DELETE them from DB). Re-anchor `lastHitAt` to `Date.now()` for loaded states.

2. **Runtime**: Every 60 seconds, flush all entries where `state.dirty === true`. Mark them clean after DB write succeeds. This satisfies NFR-1's no-per-request-DB-writes constraint.

3. **Ghost eviction**: During the same 60-second flush cycle, iterate over the map, apply lazy decay, and evict entries with penalty < 0.01 from both memory and DB. This prevents the ghost model memory leak.

4. **Shutdown**: On `SIGTERM`/`SIGINT`, flush dirty entries synchronously. Since the project uses `better-sqlite3` (synchronous), this works correctly. **Do not call `process.exit(0)` until after the flush completes.**

## 6. Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `server/src/services/degradation.ts` | **NEW** | Core degradation engine |
| `server/src/services/scoring.ts` | MODIFY | Replace `rateLimitFactor` with `degradationFactor`; delete old penalty constants |
| `server/src/services/router.ts` | MODIFY | Replace penalty map + functions with degradation module; wire into `scoreChainEntry`, `orderChain`, `getRoutingScores` |
| `server/src/routes/proxy.ts` | MODIFY | Replace `recordRateLimitHit` calls with `classifyError` + `recordFailure` |
| `server/src/routes/fallback.ts` | MODIFY | Update scores API shape; add degradation endpoint |
| `server/src/db/migrations.ts` | MODIFY | Add `model_degradation` table creation |
| `server/src/env.ts` | MODIFY | Add degradation env var parsing |
| `server/src/__tests__/services/scoring.test.ts` | MODIFY | Update to use new `ScoreInputs` shape |
| `server/src/__tests__/services/router-bandit.test.ts` | MODIFY | Update for new penalty API |
| `server/src/__tests__/services/degradation.test.ts` | **NEW** | Tests for the degradation engine |

## 7. Testing Strategy

### Unit Tests (`degradation.test.ts`)
- **classifyError**: Each error category maps to the correct tier; non-retryable errors return null; `err.status` field takes priority over message; hard quota 429 returns null; AbortError returns null
- **recordFailure → getPenalty**: Verify penalty accumulation for minor/major/critical tiers
- **Compounding exponent**: First hit uses exponent 0, second uses 1, etc. (no off-by-one)
- **Critical escalation**: Exactly 3 consecutive major hits (not 2) triggers critical — verify `consecutiveMajorHits` resets on minor hit
- **Minor failure breaks consecutive major streak**: minor → major → minor → major should NOT trigger critical (major streak was broken by the minor)
- **Time decay**: After one half-life, penalty is halved (within 1%)
- **Float snapping**: Penalty below 0.01 snaps to 0
- **Half-life ratchet**: Half-life only increases, never decreases (until penalty=0 recovery)
- **Half-life reset**: When penalty reaches 0, half-life resets to minor default
- **Success recovery**: `floor()` for deterministic steps; 30% reduction with floor of 1
- **Success resets both consecutive counters**
- **Bounds**: Penalty never exceeds MAX_PENALTY, never below 0
- **getDegradationFactor**: Correct curve values at penalty 0/5/10/25/50/100 (verified against corrected FR-5)
- **getPenalty is pure lazy read**: Does not mutate stored state
- **getAllStatesView vs getAllStatesRaw**: View returns decayed penalties; Raw returns stored penalties
- **Ghost eviction**: Entries with decayed penalty < 0.01 are evicted during flush cycle
- **Dirty flag**: Only dirty states are flushed to DB

### Integration Tests (existing suites)
- **router-bandit.test.ts**: Models with degradation should score lower
- **scoring.test.ts**: Updated `combineScore` tests with `degradationFactor`
- **proxy-retry.test.ts**: Verify degradation is recorded on retryable failures
- **proxy-rate-limit.test.ts**: Regression — client-side rate limiting unaffected

**Test timing**: Use `vi.useFakeTimers()` with explicit `vi.setSystemTime(new Date(2024, 1, 1))` to avoid executing against Unix Epoch 0.

## 8. Rollout Plan

1. **Phase 1**: `degradation.ts` module + tests (isolated, no integration)
2. **Phase 2**: Integrate into `scoring.ts` (replace `rateLimitFactor`, keep backward-compat shims)
3. **Phase 3**: Integrate into `router.ts` (replace penalty map, wire into scoring pipeline)
4. **Phase 4**: Integrate into `proxy.ts` (classify errors, wire failure/success recording)
5. **Phase 5**: DB persistence (migration + startup load with decay + periodic flush + ghost eviction)
6. **Phase 6**: Dashboard API (`/api/fallback/degradation` + scores shape update)
7. **Phase 7**: Cleanup (remove dead code, update existing tests, final integration test pass)
