# Phantom Exhaustion Fix — Implementation Tasks

## Task 1: Include `'error'` status in key eligibility queries (RC-1)

**Files to change:**

| File | Line(s) | Change |
|------|---------|--------|
| `server/src/services/router.ts` | ~L584 | Change `status IN ('healthy', 'unknown')` → `status IN ('healthy', 'unknown', 'error')` |
| `server/src/services/heartbeat.ts` | ~L163 | Change `status IN ('healthy', 'unknown')` → `status IN ('healthy', 'unknown', 'error')` |
| `server/src/services/key-exhaustion.ts` | ~L94, ~L105 | Change `status IN ('healthy', 'unknown')` → `status IN ('healthy', 'unknown', 'error')` in both `areAllKeysExhausted` and `areAllProviderKeysExhausted` |

**Verify:** Run `npm run test -w server`. Search for any other `status IN ('healthy'` occurences in server/ with grep.

## Task 2: Per-group round-robin in router key selection (RC-2)

**File to change:** `server/src/services/router.ts`

**Exact changes (L608-634):**

Replace:
```typescript
const keyOrder: KeyRow[] = keys.sort((a, b) => {
  const aHealthy = isKeyHealthy(a.id) ? 0 : 1;
  const bHealthy = isKeyHealthy(b.id) ? 0 : 1;
  return aHealthy - bHealthy;
});

// Sticky key selection: when a custom provider enables sticky sessions,
// hash the session key to pick a deterministic key. This maximizes
// upstream KV-cache reuse for cache-heavy providers like LongCAT.
const stickyRow = db.prepare(
  'SELECT sticky_sessions_enabled FROM custom_providers WHERE slug = ?'
).get(entry.platform) as { sticky_sessions_enabled: number } | undefined;
const stickyEnabled = stickyRow?.sticky_sessions_enabled === 1;

let idx: number;
if (stickyEnabled && options?.stickySessionKey) {
  const hash = crypto.createHash('sha1').update(options.stickySessionKey).digest();
  const hashInt = hash.readUInt32BE(0);
  idx = hashInt % keyOrder.length;
} else {
  idx = (roundRobinIndex.get(rrKey) ?? 0);
}

for (let attempt = 0; attempt < keyOrder.length; attempt++) {
  const key = keyOrder[(idx + attempt) % keyOrder.length];
```

With:
```typescript
// Split keys by health: healthy keys tried first, unhealthy as fallback.
// Round-robin offset applied WITHIN each group so healthy-first guarantee
// holds regardless of the offset — fixes the bug where flat offset into a
// sorted array can skip past all healthy keys (PR #31 review).
const healthyKeys = keys.filter(k => isKeyHealthy(k.id));
const unhealthyKeys = keys.filter(k => !isKeyHealthy(k.id));

// Sticky key selection: when a custom provider enables sticky sessions,
// hash the session key to pick a deterministic key. This maximizes
// upstream KV-cache reuse for cache-heavy providers like LongCAT.
const stickyRow = db.prepare(
  'SELECT sticky_sessions_enabled FROM custom_providers WHERE slug = ?'
).get(entry.platform) as { sticky_sessions_enabled: number } | undefined;
const stickyEnabled = stickyRow?.sticky_sessions_enabled === 1;

let idx: number;
if (stickyEnabled && options?.stickySessionKey) {
  // For sticky sessions, build keyOrder from full array and hash into it
  const keyOrder = [...healthyKeys, ...unhealthyKeys];
  const hash = crypto.createHash('sha1').update(options.stickySessionKey).digest();
  const hashInt = hash.readUInt32BE(0);
  idx = hashInt % keyOrder.length;
  // Place the chosen key's group at front
  var _keyOrder = keyOrder; // eslint-disable-line no-var
} else {
  // Per-group round-robin: rotate within each group independently
  const rrIdx = roundRobinIndex.get(rrKey) ?? 0;
  const hOffset = healthyKeys.length > 0 ? rrIdx % healthyKeys.length : 0;
  const uOffset = unhealthyKeys.length > 0 ? rrIdx % unhealthyKeys.length : 0;

  var _keyOrder = [ // eslint-disable-line no-var
    ...healthyKeys.slice(hOffset),
    ...healthyKeys.slice(0, hOffset),
    ...unhealthyKeys.slice(uOffset),
    ...unhealthyKeys.slice(0, uOffset),
  ];
  idx = 0; // start from beginning (healthy-first guaranteed)
}

const keyOrder = _keyOrder;

for (let attempt = 0; attempt < keyOrder.length; attempt++) {
  const key = keyOrder[(idx + attempt) % keyOrder.length];
```

**Note for implementer:** The `var` trick avoids a redeclaration issue with the two branches. A cleaner approach is to declare `let keyOrder` before the if/else and assign in each branch. Use whichever matches the codebase style.

**Also update** the round-robin advancement at the bottom of the model block (currently ~L693):

```typescript
if (!(stickyEnabled && options?.stickySessionKey)) {
  roundRobinIndex.set(rrKey, (idx + 1) % keys.length);
}
```

This should remain as-is — it advances the offset for the NEXT call. The per-group rotation in the keyOrder construction handles the grouping.

**Verify:** Run `npm run test -w server`. Pay special attention to router tests that check key selection order with mixed health keys.

## Task 3: Model-specific errors don't poison global key health (RC-3)

**File to change:** `server/src/services/heartbeat.ts`, `pingKey()` function, the `catch` block (~L237-270)

**Exact changes:**

Replace the current error-handling block:
```typescript
} catch (err: any) {
    const latencyMs = Date.now() - start;
    const tier = classifyError(err);

    // Update per-key health
    const prev = keyHealthMap.get(keyRow.id);
    const newPenalty = (prev?.penalty ?? 0) + 1;
    keyHealthMap.set(keyRow.id, {
      penalty: newPenalty,
      lastPingAt: Date.now(),
      healthy: false,
      lastError: (err?.message ?? 'unknown').slice(0, 120),
    });

    // Only record model-level degradation for retryable errors (5xx, 429)
    // Non-retryable (401, 403, 404) are config issues, not health signals
    if (tier === 'major') {
      recordFailure(modelDbId, 'major');
    } else if (tier === 'minor') {
      recordFailure(modelDbId, 'minor');
    }
    // tier === null → non-retryable config error, log but don't penalize

    publish({
      type: 'heartbeat.ping',
      ...
    });
  }
```

With:
```typescript
} catch (err: any) {
    const latencyMs = Date.now() - start;
    const tier = classifyError(err);

    // Model-specific errors (403/404) mean the key is valid but this model
    // isn't accessible on its tier. Don't poison the key's global health —
    // only genuine failures (5xx, timeout, 429) should penalize the key.
    const isModelError = err?.status === 403 || err?.status === 404
      || /forbidden|not found|no endpoints found/i.test(err?.message ?? '');

    if (!isModelError) {
      const prev = keyHealthMap.get(keyRow.id);
      const newPenalty = (prev?.penalty ?? 0) + 1;
      keyHealthMap.set(keyRow.id, {
        penalty: newPenalty,
        lastPingAt: Date.now(),
        healthy: false,
        lastError: (err?.message ?? 'unknown').slice(0, 120),
      });
    }

    // Model-level degradation: only for retryable errors (5xx, 429).
    // Model-specific (403/404) are config issues, not health signals.
    if (tier === 'major') {
      recordFailure(modelDbId, 'major');
    } else if (tier === 'minor') {
      recordFailure(modelDbId, 'minor');
    }
    // tier === null → non-retryable config error, log but don't penalize

    publish({
      type: 'heartbeat.ping',
      provider: platform,
      model: modelId,
      keyId: keyRow.id,
      success: false,
      latencyMs,
      error: (err?.message ?? 'unknown').slice(0, 120),
      at: Date.now(),
    });
  }
```

**Verify:** Run `npm run test -w server`. Check heartbeat.test.ts.

## Task 4: Exhaustion map TTL sweep (RC-4)

**Files to change:**

### 4a: `server/src/services/key-exhaustion.ts` — add sweep function

Add after the existing `areAllProviderKeysExhausted` function:

```typescript
/** Remove exhaustion entries whose associated cooldown has expired in the DB.
 *  Called periodically to prevent stale entries from accumulating indefinitely. */
export function sweepStaleExhaustion(): number {
  const db = getDb();
  const now = Date.now();
  let swept = 0;
  for (const [keyId, info] of exhaustionMap) {
    const row = db.prepare(`
      SELECT 1 FROM rate_limit_cooldowns
      WHERE key_id = ? AND model_id = ? AND expires_at_ms > ?
    `).get(keyId, info.modelId, now) as unknown;
    if (!row) {
      exhaustionMap.delete(keyId);
      swept++;
    }
  }
  return swept;
}
```

### 4b: `server/src/index.ts` — start the sweep interval

Near the existing health checker start, add:

```typescript
import { sweepStaleExhaustion } from './services/key-exhaustion.js';

// ... in the startup section, after startHealthChecker() ...

// Sweep stale exhaustion entries every 60s
const exhaustionSweep = setInterval(() => {
  const swept = sweepStaleExhaustion();
  if (swept > 0) console.log(`[Exhaustion] Swept ${swept} stale entries`);
}, 60_000);
exhaustionSweep.unref();
```

**Verify:** Run `npm run test -w server`. Add a unit test in key-exhaustion tests: mark exhausted → set cooldown → advance time past cooldown → sweep → verify entry removed.

## Execution Order

Tasks are independent — can be implemented in any order or in parallel. Recommended priority:

1. **Task 1** (RC-1) — highest impact, smallest change (3 SQL strings)
2. **Task 2** (RC-2) — high impact, moderate change
3. **Task 3** (RC-3) — high impact for tier-gated providers, moderate change
4. **Task 4** (RC-4) — housekeeping, lowest priority

After all tasks: `npm run build && npm run test` to validate.
