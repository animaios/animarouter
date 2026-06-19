# Dynamic Degradation System — Implementation Tasks

> **SOP**: Each task is one `spawn_agent` call. The agent is stateless — pass full context, symbol IDs, and jCodeMunch instructions in every prompt. After each task, review the diff before proceeding.

---

## Task 1: Create Degradation Engine Core (`degradation.ts`)

**Files created**: `server/src/services/degradation.ts`

**Files touched**: none (new file only)

### What to build

Create `server/src/services/degradation.ts` with the full degradation engine. This file is pure logic — no database access, no HTTP concerns.

### Exact interfaces to implement

```typescript
// ── Configuration (from env → frozen object) ────────────────────────────────

interface DegradationTierConfig {
  weight: number;
  halfLifeMs: number;
}

interface DegradationConfig {
  minor: DegradationTierConfig;
  major: DegradationTierConfig;
  critical: DegradationTierConfig & { consecutiveThreshold: number };
  compoundFactor: number;
  successRecovery: number;
  dampStrength: number;
  maxPenalty: number;
}

// ── Per-model state ──────────────────────────────────────────────────────────

interface DegradationState {
  penalty: number;
  tier: 'minor' | 'major' | 'critical';
  consecutiveHits: number;        // ALL classified failures since last success
  consecutiveMajorHits: number;   // Only major-classified failures; resets on success OR minor hit
  lastHitAt: number;              // Date.now() ms — ALWAYS a valid number, never undefined
  halfLifeMs: number;
  dirty: boolean;                 // true if state changed since last DB flush
}
```

### Exported public API

All of these must be exported with `export function`:

| Function | Signature | Behavior |
|----------|-----------|----------|
| `initDegradation(configOverrides?)` | `void` | Reads env vars (see FR-7), merges overrides, freezes config. Idempotent. |
| `classifyError` | `(err: any) => 'minor' \| 'major' \| null` | See design doc §3.1. Status code field first, message fallback. Hard quota 429 → null. AbortError → null. |
| `recordFailure` | `(modelDbId: number, tier: 'minor' \| 'major') => void` | See design doc §3.2. Compounding with `max(0, consecutiveHits-1)` exponent. Uses `consecutiveMajorHits` for critical escalation. Marks dirty. |
| `recordSuccess` | `(modelDbId: number) => void` | See design doc §3.3. `floor()` deterministic recovery. Resets BOTH consecutive counters. Marks dirty. |
| `getPenalty` | `(modelDbId: number) => number` | Lazy time-decayed penalty (read-only, never mutates stored state). |
| `getDegradationFactor` | `(modelDbId: number) => number` | `1 / (1 + normalized² × dampStrength)`. See corrected FR-5. |
| `getDisplayTier` | `(penalty: number) => string` | `'healthy'` (0), `'minor'` (1-10), `'major'` (10-30), `'critical'` (>30). |
| `getAllStatesRaw` | `() => Map<number, DegradationState>` | Returns a COPY — raw stored penalties, no decay applied. For persistence. |
| `getAllStatesView` | `() => Map<number, DegradationState & { displayTier: string }>` | Returns a COPY — time-decayed penalties with displayTier. For dashboard/API. |
| `loadState` | `(modelDbId: number, state: DegradationState) => void` | Hydrate a saved state into the in-memory map (startup from DB). |
| `flushDirtyStates` | `() => Array<{ modelDbId: number; state: DegradationState }>` | Returns states where `dirty === true`. Marks them as clean (dirty=false). |
| `evictGhostStates` | `() => number[]` | Evicts entries with lazy-decayed penalty < 0.01. Returns evicted modelDbIds. |

### Internal helpers (not exported)

| Function | Purpose |
|----------|---------|
| `applyDecay(penalty, elapsedMs, halfLifeMs)` | `penalty × 0.5^(elapsed / halfLife)`. Snaps to 0 when result < 0.01. Pure, no side effects. |
| `getOrCreateState(modelDbId)` | Returns existing or default `DegradationState` with penalty=0, tier='minor', consecutiveHits=0, consecutiveMajorHits=0, lastHitAt=Date.now(), halfLifeMs=minor default, dirty=false. |

### Environment variables to read

Parse these once in `initDegradation`. Use `process.env` directly — no env.ts integration needed (that's a separate task).

| Env Var | Config Key | Default | Type |
|---------|-----------|---------|------|
| `DEGRADE_MINOR_WEIGHT` | `minor.weight` | `1.0` | number |
| `DEGRADE_MAJOR_WEIGHT` | `major.weight` | `3.0` | number |
| `DEGRADE_CRITICAL_WEIGHT` | `critical.weight` | `6.0` | number |
| `DEGRADE_COMPOUND_FACTOR` | `compoundFactor` | `1.5` | number |
| `DEGRADE_MINOR_HALF_LIFE_MIN` | `minor.halfLifeMs` | `120000` (2 min) | minutes→ms |
| `DEGRADE_MAJOR_HALF_LIFE_MIN` | `major.halfLifeMs` | `900000` (15 min) | minutes→ms |
| `DEGRADE_CRITICAL_HALF_LIFE_MIN` | `critical.halfLifeMs` | `3600000` (60 min) | minutes→ms |
| `DEGRADE_SUCCESS_RECOVERY` | `successRecovery` | `0.3` | number |
| `DEGRADE_DAMP_STRENGTH` | `dampStrength` | `50` | number |
| `DEGRADE_MAX_PENALTY` | `maxPenalty` | `100` | number |
| `DEGRADE_CRITICAL_THRESHOLD` | `critical.consecutiveThreshold` | `3` | number |

Note: The env var names say `_MIN` for minutes but the config stores ms. Convert: `parseInt(env) * 60 * 1000`.

### Critical invariants (enforce these)

1. `recordFailure` must apply time-decay to the **stored** penalty before adding the increment (re-anchors to now)
2. `recordSuccess` must apply time-decay before computing recovery
3. `getPenalty` applies time-decay lazily — returns the decayed value but does **not** mutate stored penalty
4. The half-life on state **ratchets up** — only `max(current, new)`. Never decreases EXCEPT when penalty reaches 0 (then resets to minor default)
5. `recordSuccess` resets BOTH `consecutiveHits` AND `consecutiveMajorHits` to 0
6. `recordFailure` with tier='minor' resets `consecutiveMajorHits` to 0 (breaks the major streak)
7. Critical escalation: when `tier === 'major'` AND `consecutiveMajorHits >= critical.consecutiveThreshold`, the effective tier becomes `'critical'`
8. Use `publish()` from the events service for event emission — import as `import { publish } from './events.js'`
9. Penalty clamped to `[0, maxPenalty]`
10. `applyDecay` snaps result < 0.01 to exactly 0
11. `lastHitAt` defaults to `Date.now()` in `getOrCreateState` — never undefined/null
12. Compounding exponent is `Math.max(0, consecutiveHits - 1)` — no negative exponents possible
13. Success recovery uses `Math.floor()` for deterministic integer steps
14. Every mutation that changes penalty must set `dirty = true`
15. `flushDirtyStates` sets `dirty = false` on returned entries
16. `classifyError` checks `err.status ?? err.statusCode ?? err.response?.status` FIRST, then falls back to message matching

---

## Task 2: Unit Tests for Degradation Engine

**Files created**: `server/src/__tests__/services/degradation.test.ts`

**Files touched**: none (new file only)

### Test structure

Use `vitest` (the project's test framework). The test file should import from `../../services/degradation.js`.

Before each test: call `initDegradation()` to reset config to defaults. Do NOT import or touch the database.

**Important**: Use `vi.useFakeTimers()` AND set an explicit start time:
```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2024, 1, 1)); // Avoid Unix Epoch 0
  initDegradation();
});
afterEach(() => {
  vi.useRealTimers();
});
```

Mock `publish`:
```typescript
vi.mock('../../services/events.js', () => ({
  publish: vi.fn(),
}));
```

### Test cases (minimum set)

#### Group: `classifyError`

1. Returns `'minor'` for 429 (via `err.status = 429`)
2. Returns `'minor'` for 402 (via status code)
3. Returns `'major'` for 500, 502, 503, 504 (via status codes)
4. Returns `'major'` for ECONNREFUSED, ETIMEDOUT, timeout, fetch failed (via message)
5. Returns `'major'` for EPROTO, ECONNABORTED (TLS errors via message)
6. Returns `null` for 400, 401, 403, 404 (non-retryable, via status codes)
7. Returns `null` for 429 with "quota" or "insufficient" in message (hard quota)
8. Returns `null` for AbortError (`err.name = 'AbortError'`)
9. Returns `null` for a generic non-http error without recognized markers
10. Status code field takes priority over message (e.g., `err.status=503` with message that doesn't contain "503")

#### Group: `recordFailure` + `getPenalty`

11. First minor hit → penalty ≈ 1.0 (exponent 0, no compounding)
12. First major hit → penalty ≈ 3.0
13. Second consecutive minor: penalty = 1.0 + 1.0×1.5¹ = 2.5
14. Third consecutive minor: penalty = 2.5 + 1.0×1.5² = 4.75
15. After success, next minor hit is weight×factor⁰ again (no compound)
16. Critical escalation: exactly 3 consecutive major hits → critical weight used
17. `consecutiveMajorHits` increments only on major, resets on minor hit
18. Sequence minor → major → minor → major does NOT trigger critical (streak broken)
19. Half-life changes to critical (60min) on critical escalation

#### Group: Time Decay

20. After one half-life of idle, penalty is approximately halved (within 1%)
21. After two half-lives, penalty is ≈ ¼
22. `getPenalty` is lazy — does NOT mutate stored penalty (call twice, verify same stored value)
23. Decay never produces negative penalty
24. Penalty below 0.01 after decay snaps to exactly 0

#### Group: `recordSuccess`

25. Success at penalty=100: floor(100×0.3)=30, 100-30=70
26. Success at penalty=3: floor(3×0.3)=0 → max(1,0)=1, 3-1=2
27. Success resets `consecutiveHits` to 0
28. Success resets `consecutiveMajorHits` to 0
29. Success on penalty=0 is a no-op (doesn't create state)
30. When penalty reaches 0, half-life resets to minor default

#### Group: `getDegradationFactor` (CORRECTED values)

31. At penalty=0 → factor = 1.0
32. At penalty=5 → factor ≈ 0.889 (within 0.01)
33. At penalty=10 → factor ≈ 0.667 (within 0.01)
34. At penalty=25 → factor ≈ 0.242 (within 0.01)
35. At penalty=100 → factor ≈ 0.020 (within 0.005)
36. Factor is monotonically decreasing with penalty
37. Factor never goes below 0, never above 1

#### Group: Bounds + Dirty Flag

38. Penalty never exceeds MAX_PENALTY (100) even with many rapid hits
39. Penalty never goes negative after success on decayed-to-near-zero
40. Compounding factor of 1.0 (via config override) disables compounding (just the weight)
41. Mutations set `dirty = true`; non-mutating reads don't
42. `flushDirtyStates` returns only dirty entries and clears their dirty flag
43. `evictGhostStates` removes entries with decayed penalty < 0.01

#### Group: API Shape

44. `getAllStatesRaw()` returns stored penalties (no decay)
45. `getAllStatesView()` returns decayed penalties + displayTier
46. `loadState()` then `getPenalty()` returns the loaded penalty (with lazy decay)

---

## Task 3: Integrate Degradation into `scoring.ts`

**Files modified**: `server/src/services/scoring.ts`

### Changes

1. **DELETE** the following exports: `rateLimitFactor`, `MAX_PENALTY`, `RATE_LIMIT_MAX_DAMP`

2. **RENAME** in `ScoreInputs`: `rateLimit: number` → `degradationFactor: number`

3. **UPDATE** `combineScore()`: change `return base * inputs.rateLimit` → `return base * inputs.degradationFactor`

4. **UPDATE** JSDoc in `combineScore` to reference "degradation factor" instead of "rate limit guardrail"

5. **KEEP** everything else unchanged: `BANDIT_PRESETS`, `DEFAULT_STRATEGY`, `reliabilityPosterior`, `expectedReliability`, `speedScore`, `heavyWeightedSpeedScore`, `intelligenceScore`, `speedCompositeFromRank`, `sampleBeta` — all stay.

### What NOT to change

- Do NOT touch `SPEED_PRIOR`, `SPEED_SCALE_TOK_S`, `TTFB_BEST_MS`, etc.
- Do NOT add any import from `degradation.js` — scoring.ts doesn't need it. It just accepts `degradationFactor` as an input parameter.

Note: `router.ts` will have broken imports until Task 4 fixes them. That's expected.

---

## Task 4: Integrate Degradation into `router.ts`

**Files modified**: `server/src/services/router.ts`

### Changes

1. **DELETE** lines 111-187 (the entire `rateLimitPenalties` map, `recordRateLimitHit`, `clearRateLimitPenalty`, `recordSuccess`, `getPenalty`, `getAllPenalties`, and all associated constants: `PENALTY_PER_429`, `DECAY_INTERVAL_MS`, `DECAY_AMOUNT`)

2. **UPDATE** the import on line 7-12 to REMOVE `rateLimitFactor, MAX_PENALTY` from the scoring import. Keep: `BANDIT_PRESETS, DEFAULT_STRATEGY, RoutingStrategy, RoutingWeights, reliabilityPosterior, expectedReliability, sampleBeta, speedScore, heavyWeightedSpeedScore, speedCompositeFromRank, intelligenceScore, combineScore`

3. **ADD** import: `import { getDegradationFactor, getPenalty, getAllStatesView, initDegradation, recordFailure, recordSuccess } from './degradation.js';`

4. **UPDATE** `scoreChainEntry()` (lines 408-456): Replace `const rl = rateLimitFactor(getPenalty(entry.model_db_id));` with `const degradationFactor = getDegradationFactor(entry.model_db_id);` and update the `combineScore` call to pass `degradationFactor` instead of `rateLimit: rl`.

5. **RENAME** in `ScoredEntry` interface (line 405): `rateLimit: number` → `degradationFactor: number`

6. **UPDATE** `getRoutingScores()` (lines 776-823): Same change — use `getDegradationFactor(modelDbId)` and rename the field in the returned scores object.

7. **UPDATE** `getAllPenalties()` → replace with a wrapper that calls `getAllStatesView()` and maps to the format expected by `fallback.ts`:
   ```typescript
   export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
     const states = getAllStatesView();
     const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
     for (const [modelDbId, state] of states) {
       if (state.penalty > 0) {
         result.push({ modelDbId, count: state.consecutiveHits, penalty: state.penalty });
       }
     }
     return result.sort((a, b) => b.penalty - a.penalty);
   }
   ```

8. **ADD** initialization guard at module level:
   ```typescript
   let degradationInitialized = false;
   function ensureDegradationInit() {
     if (!degradationInitialized) {
       initDegradation();
       degradationInitialized = true;
     }
   }
   ```
   Call `ensureDegradationInit()` at the top of `getRoutingStrategy()`.

9. **KEEP** the `recordRateLimitHit` and `recordSuccess` function signatures as deprecated re-exports (so `proxy.ts` doesn't break until Task 6):
   ```typescript
   /** @deprecated Use classifyError + recordFailure from degradation module directly. */
   export function recordRateLimitHit(modelDbId: number) {
     recordFailure(modelDbId, 'minor');
   }

   /** @deprecated Use recordSuccess from degradation module directly. */
   export { recordSuccess };
   ```

---

## Task 5: Update Scoring + Router Tests

**Files modified**:
- `server/src/__tests__/services/scoring.test.ts`
- `server/src/__tests__/services/router-bandit.test.ts`

### Changes to `scoring.test.ts`

1. **REMOVE** the `rateLimitFactor` import from line 3-6. Keep: `BANDIT_PRESETS, combineScore, speedScore, intelligenceScore, sampleBeta, reliabilityPosterior, expectedReliability, SPEED_PRIOR`

2. **UPDATE** all `combineScore` calls: `rateLimit` → `degradationFactor`. e.g.:
   - Line 70: `{ reliability: 1, speed: 1, intelligence: 1, rateLimit: 1 }` → `{ reliability: 1, speed: 1, intelligence: 1, degradationFactor: 1 }`
   - Line 74: `{ reliability: 0, speed: 0, intelligence: 0, rateLimit: 1 }` → rename
   - Line 78-79: rename all occurrences
   - Line 84-85: rename
   - Line 90-91: rename
   - Line 96: `{ ...perfect, rateLimit: 0.4 }` → `{ ...perfect, degradationFactor: 0.4 }`

3. **REMOVE** the "guardrails" test group (lines 61-66) that tests `rateLimitFactor` directly. Add a comment: `// Degradation factor tests are in degradation.test.ts`

4. **CHANGE** "it guardrails multiply the base down" test (lines 95-99) assertion text to "degradation factor multiplies base down"

### Changes to `router-bandit.test.ts`

Read the file first. Focus on:
1. Any import of `recordRateLimitHit`, `recordSuccess`, `getAllPenalties` — verify they still work with wrappers
2. Any assertion on `rateLimit` in score output — rename to `degradationFactor`
3. If no direct references exist, no changes needed

---

## Task 6: Integrate Degradation into `proxy.ts`

**Files modified**: `server/src/routes/proxy.ts`

### Changes

1. **ADD** import: `import { classifyError, recordFailure } from '../services/degradation.js'`

2. **FIND** all call sites of `recordRateLimitHit(route.modelDbId)`. These are at:
   - Mid-stream error handler (streamErr)
   - Outer retry handler (lastError)

3. **REPLACE** each `recordRateLimitHit(route.modelDbId)` with:
   ```typescript
   const tier = classifyError(lastError); // or streamErr depending on scope
   if (tier) {
     recordFailure(route.modelDbId, tier);
   }
   ```
   The error objects in proxy.ts often have `err.status` set by the provider adapters — `classifyError` will use that numeric field first, making classification reliable.

4. **The `recordSuccess(route.modelDbId)` calls** stay as-is (router.ts delegates to degradation module).

5. **If `route.rateLimit`** is destructured from `RouteResult`, rename to `route.degradationFactor`. If it's just passed through, update accordingly.

### Note

`proxy.ts` is a large file (~1300 lines). Only change the import and the `recordRateLimitHit` call sites. Do NOT refactor anything else.

---

## Task 7: Database Migration + Persistence

**Files modified**: `server/src/db/migrations.ts`, `server/src/index.ts` (or `app.ts`)

### Migration

Add a migration function to `server/src/db/migrations.ts`:

```typescript
function createDegradationTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_degradation (
      model_db_id   INTEGER PRIMARY KEY,
      penalty       REAL    NOT NULL DEFAULT 0,
      tier          TEXT    NOT NULL DEFAULT 'minor',
      consecutive   INTEGER NOT NULL DEFAULT 0,
      consecutive_major INTEGER NOT NULL DEFAULT 0,
      last_hit_at   INTEGER,
      half_life_ms  INTEGER NOT NULL DEFAULT 120000,
      FOREIGN KEY (model_db_id) REFERENCES models(id) ON DELETE CASCADE
    );
  `);
}
```

Call this in the main migration runner where other `ensure*` functions are called.

### Startup Load (with decay during hydration)

```typescript
import { loadState, initDegradation, applyDecay } from './services/degradation.js';

// After initDb()...
initDegradation();

// Load persisted degradation state from DB — apply decay to stale data
const now = Date.now();
const rows = getDb().prepare('SELECT * FROM model_degradation').all() as any[];
for (const row of rows) {
  const elapsed = now - (row.last_hit_at ?? now);
  const decayedPenalty = applyDecay(row.penalty, elapsed, row.half_life_ms);

  if (decayedPenalty >= 0.01) {
    loadState(row.model_db_id, {
      penalty: decayedPenalty,
      tier: row.tier,
      consecutiveHits: row.consecutive,
      consecutiveMajorHits: row.consecutive_major,
      lastHitAt: now,  // Re-anchor to now
      halfLifeMs: row.half_life_ms,
      dirty: false,
    });
  } else {
    // Dead data — clean up DB row
    getDb().prepare('DELETE FROM model_degradation WHERE model_db_id = ?').run(row.model_db_id);
  }
}
```

Note: `applyDecay` must be exported from `degradation.ts` for this to work. Add it to the exports list if not already exported.

### Periodic Persistence + Ghost Eviction (every 60 seconds)

```typescript
import { flushDirtyStates, evictGhostStates } from './services/degradation.js';

const FLUSH_INTERVAL_MS = 60_000;

setInterval(() => {
  // 1. Flush dirty states to DB
  const dirty = flushDirtyStates();
  if (dirty.length > 0) {
    const upsert = getDb().prepare(`
      INSERT OR REPLACE INTO model_degradation
      (model_db_id, penalty, tier, consecutive, consecutive_major, last_hit_at, half_life_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const { modelDbId, state } of dirty) {
      upsert.run(modelDbId, state.penalty, state.tier,
        state.consecutiveHits, state.consecutiveMajorHits,
        state.lastHitAt, state.halfLifeMs);
    }
  }

  // 2. Evict ghost models (decayed to near-zero, no longer referenced)
  const evicted = evictGhostStates();
  if (evicted.length > 0) {
    const del = getDb().prepare('DELETE FROM model_degradation WHERE model_db_id = ?');
    for (const id of evicted) {
      del.run(id);
    }
  }
}, FLUSH_INTERVAL_MS);
```

### Shutdown Handler (synchronous flush — better-sqlite3 is sync)

```typescript
import { flushDirtyStates } from './services/degradation.js';

function shutdownFlush() {
  try {
    const dirty = flushDirtyStates();
    if (dirty.length > 0) {
      const upsert = getDb().prepare(`
        INSERT OR REPLACE INTO model_degradation
        (model_db_id, penalty, tier, consecutive, consecutive_major, last_hit_at, half_life_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const { modelDbId, state } of dirty) {
        upsert.run(modelDbId, state.penalty, state.tier,
          state.consecutiveHits, state.consecutiveMajorHits,
          state.lastHitAt, state.halfLifeMs);
      }
    }
  } catch (e) {
    console.error('[Shutdown] Degradation flush failed:', e);
  }
  process.exit(0);
}
process.on('SIGTERM', shutdownFlush);
process.on('SIGINT', shutdownFlush);
```

---

## Task 8: Dashboard API Updates (`fallback.ts`)

**Files modified**: `server/src/routes/fallback.ts`

### Changes

1. **ADD** import: `import { getAllStatesView, getDisplayTier } from '../services/degradation.js';`

2. **ADD** a new endpoint `GET /api/fallback/degradation`:
   ```typescript
   fallbackRouter.get('/degradation', (_req: Request, res: Response) => {
     const states = getAllStatesView();
     const result: any[] = [];
     for (const [modelDbId, state] of states) {
       const model = getDb().prepare(
         'SELECT platform, model_id, display_name FROM models WHERE id = ?'
       ).get(modelDbId) as any;
       result.push({
         modelDbId,
         platform: model?.platform,
         modelId: model?.model_id,
         displayName: model?.display_name,
         penalty: state.penalty,
         displayTier: state.displayTier,
         consecutiveHits: state.consecutiveHits,
         consecutiveMajorHits: state.consecutiveMajorHits,
         halfLifeMs: state.halfLifeMs,
         estimatedRecoveryMs: state.penalty > 1
           ? state.halfLifeMs * Math.log2(state.penalty) // time to reach penalty=1
           : null,  // null when penalty <= 1 (already recovered or near-zero)
         lastHitAt: state.lastHitAt,
       });
     }
     res.json(result);
   });
   ```

3. **UPDATE** `GET /api/fallback/routing` scores response: rename `rateLimit` to `degradationFactor`.

4. **KEEP** `GET /api/fallback/penalties` working (uses `getAllPenalties()` wrapper from router.ts).

---

## Task 9: Cleanup and Final Integration

**Files modified**: multiple

### What to do

1. **Remove deprecated wrappers** from `router.ts`:
   - Delete the `recordRateLimitHit` re-export
   - Update `proxy.ts` to import `recordSuccess` and `recordFailure` directly from `'../services/degradation.js'`

2. **Export `applyDecay`** from `degradation.ts` if not already (needed by Task 7 startup hydration).

3. **Run the full test suite**:
   ```bash
   cd server && npx vitest run
   ```
   Verify all tests pass. If any fail, fix them.

4. **Run the routing simulation** to verify scoring behavior:
   ```bash
   cd server && npm run build && node dist/scripts/routing-sim.js
   ```

5. **Check for remaining references** to the old API:
   ```bash
   grep -r "rateLimitFactor\|MAX_PENALTY\|RATE_LIMIT_MAX_DAMP\|PENALTY_PER_429\|DECAY_INTERVAL_MS\|DECAY_AMOUNT" server/src/ --include="*.ts" | grep -v node_modules | grep -v __tests__
   ```
   Only test files should reference these (and even those should be updated in Task 5).

---

## Dependency Graph

```
Task 1 (degradation.ts)
  ├── Task 2 (degradation tests) — parallel with Task 1 after Task 1 is done
  └── Task 3 (scoring.ts) — depends on Task 1
        ├── Task 4 (router.ts) — depends on Task 3
        │     └── Task 6 (proxy.ts) — depends on Task 4
        ├── Task 5 (test updates) — depends on Task 3 + Task 4
        ├── Task 7 (DB persistence) — depends on Task 1 (only needs the engine)
        └── Task 8 (dashboard API) — depends on Task 4
              └── Task 9 (cleanup) — depends on ALL
```

Recommended execution order: 1 → 2,3 (parallel) → 4 → 5,6,7,8 (parallel) → 9
