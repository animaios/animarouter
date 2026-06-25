# Heartbeat Auto-Disable — Design Document

## 1. Architecture Overview

### Integration with Existing Systems

This feature is a **post-cycle evaluation** layered on top of the Provider Health Heartbeat system. It does not modify the routing path, request handling, or scoring algorithms. The only entry point is after `runCycle()` completes its pings.

```
┌─────────────────────────────────────────────────┐
│              Heartbeat Cycle (runCycle)          │
│                                                  │
│  1. Activity gate                               │
│  2. Query enabled models + keys                 │
│  3. Ping each key (staggered)                   │
│  4. Update keyHealthMap per ping result          │
│  5. ┌─────────────────────────────────────────┐ │
│    │ NEW: evaluateAutoDisable() per model     │   │
│    │   - Count unhealthy / total keys         │   │
│    │   - If pct >= threshold → models.enabled=0│   │
│    │   - Publish heartbeat.auto_disable event │   │
│    └─────────────────────────────────────────┘ │
│  6. Clear cycleInProgress flag                  │
└─────────────────────────────────────────────────┘
```

The feature reads from the same `keyHealthMap` that the 429 Key Exclusion spec writes to. This means:
- Keys evicted by 429 traffic (spec 1) are counted as unhealthy by the auto-disable check (spec 2)
- Both mechanisms reinforce each other: a key that 429s gets evicted, which inflates the unhealthy count, which can trigger auto-disable

### Relationship to Other Specs

| Spec | Interaction |
|---|---|
| `provider-health-heartbeat` | Foundation — provides `keyHealthMap`, `isKeyHealthy()`, `runCycle()`, `pingKey()` |
| `429-key-exclusion` | Feeds auto-disable — evicted keys (`healthy: false`) are counted as unhealthy |
| `dynamic-degradation` | Parallel — degradation accumulates penalty; auto-disable is a harder action (disabled in DB) |
| `provider-outage-fast-fail` | Independent — fast-fail is per-request; auto-disable is per-cycle |
| `smart-routing-thresholds` | Independent — threshold scoring doesn't affect the auto-disable count |

---

## 2. Core Data Model

### 2.1 No New Data Structures

The auto-disable evaluation reads from:
- `keyHealthMap` (in-memory, from `heartbeat.ts`) — existing
- `api_keys` table — existing
- `models` table — existing, uses `enabled` column

The only new persistent state is:
- `models.auto_disabled_at` — new column, distinguishes auto-disable from manual disable

### 2.2 Threshold Configuration

New feature setting registered in `feature-settings.ts`:

```typescript
{
  key: 'heartbeat_auto_disable_pct',
  label: 'Auto-Disable Unhealthy Key %',
  description:
    'When ≥ this percentage of a model\'s API keys are unhealthy (heartbeat pings failing or 429-evicted), the model is automatically disabled. Set to 0 to disable auto-disable entirely; set to 100 to disable only when all keys fail; set to 1 for aggressive single-key triggering.',
  type: 'number',
  default: 0,
  min: 0,
  max: 100,
  envVar: 'HEARTBEAT_AUTO_DISABLE_PCT',
  effect: 'live',
  group: 'Resilience',
  parentToggle: 'heartbeat_enabled',
}
```

---

## 3. Algorithm Details

### 3.1 `evaluateAutoDisable()` — Core Function

```typescript
interface AutoDisableResult {
  modelDbId: number;
  platform: string;
  modelId: string;
  totalKeys: number;
  unhealthyKeys: number;
  disabled: boolean;
}

function evaluateAutoDisable(
  db: ReturnType<typeof getDb>,
  modelDbId: number,
  platform: string,
  modelId: string,
): AutoDisableResult | null {
  const threshold = getAutoDisableThresholdPct();
  if (threshold === 0) return null; // Feature disabled
  const allKeys = db.prepare(
    "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1"
  ).all(platform) as Array<{ id: number }>;

  const total = allKeys.length;
  if (total === 0) return null;

  let unhealthy = 0;
  for (const k of allKeys) {
    const health = keyHealthMap.get(k.id);
    if (health && !health.healthy) unhealthy++;
    else if (!health) unhealthy++; // Cold key = assumed unhealthy
  }

  const pct = (unhealthy / total) * 100;
  if (pct < threshold) return null;

  const info = db.prepare(
    "SELECT enabled FROM models WHERE id = ?"
  ).get(modelDbId) as { enabled: number } | undefined;

  if (!info || info.enabled === 0) {
    return { modelDbId, platform, modelId, totalKeys: total, unhealthyKeys: unhealthy, disabled: false };
  }

  // Disable the model and mark it as auto-disabled
  db.prepare(
    "UPDATE models SET enabled = 0, auto_disabled_at = datetime('now') WHERE id = ?"
  ).run(modelDbId);

  return { modelDbId, platform, modelId, totalKeys: total, unhealthyKeys: unhealthy, disabled: true };
}
```

Key design decisions:
1. **Cold keys count as unhealthy** — consistent with `isKeyHealthy()` behavior when heartbeat is enabled
2. **Platform-wide key counting** — doesn't count per-model keys (providers share keys across models)
3. **`AND enabled = 1` guard** — prevents redundant writes and double-events
4. **`auto_disabled_at` set in same WRITE** — atomic; if the UPDATE fires, both columns change together

### 3.2 Integration into `runCycle()`

After all pings complete and before clearing `cycleInProgress`:

```typescript
async function runCycle(skipGate = false): Promise<void> {
  if (cycleInProgress) return;
  cycleInProgress = true;

  try {
    const now = Date.now();
    // ... activity gate, model/key queries, pings ...

    // ── Auto-disable evaluation ──
    for (const key of pingedModels) {
      const parts = key.split(':');
      const platform = parts[0];
      const modelDbIdStr = parts[1];
      const modelId = parts.slice(2).join(':'); // model IDs may contain colons (e.g. qwen3-coder:480b)
      const modelDbId = parseInt(modelDbIdStr, 10);
      const result = evaluateAutoDisable(db, modelDbId, platform, modelId);
      if (result?.disabled) {
        publish({
          type: 'heartbeat.auto_disable',
          provider: result.platform,
          model: result.modelId,
          modelDbId: result.modelDbId,
          totalKeys: result.totalKeys,
          unhealthyKeys: result.unhealthyKeys,
          threshold: getAutoDisableThresholdPct(),
          at: Date.now(),
        });
      }
    }
  } finally {
    cycleInProgress = false;
  }
}
```

### 3.3 Tracking Pinged Models

A new `Set<string>` within `runCycle()` tracks which `(platform, modelDbId, modelId)` tuples were pinged. The auto-disable evaluation iterates over this set rather than re-querying the DB for enabled models (since some may have just been disabled during the same cycle).

```typescript
const pingedModels = new Set<string>(); // "platform:modelDbId:modelId" dedup key

// Add per model BEFORE the key loop (not inside it), so every model on a
// shared platform gets registered for auto-disable evaluation even though
// their keys are deduplicated by seenKeys.
if (keys.length > 0) {
  pingedModels.add(`${model.platform}:${model.model_db_id}:${model.model_id}`);
}

for (const key of keys) {
```

### 3.4 Threshold Slider on Settings UI

The `heartbeat_auto_disable_pct` setting uses `type: 'number'`, `min: 1`, `max: 100`. The existing Settings UI renders number settings with a text input. For this setting specifically, the UX should surface it as a **range slider** with the numeric value shown alongside — but this is a client-side UX enhancement, not a server requirement. The server exposes it as a standard number setting; the client can render it as a slider.

---

## 4. Integration Points

### 4.1 Changes to `heartbeat.ts`

1. Add `getAutoDisableThresholdPct()` helper (reads from `getFeatureSetting`)
2. Add `evaluateAutoDisable()` function (~30 lines)
3. Modify `runCycle()` to track pinged models and evaluate after pings (~15 lines)

### 4.2 Changes to `feature-settings.ts`

Add one new registry entry in the `Resilience` group with `parentToggle: 'heartbeat_enabled'`:

```typescript
{
  key: 'heartbeat_auto_disable_pct',
  label: 'Auto-Disable Unhealthy Key %',
  description:
    'When ≥ this percentage of a model\'s API keys are unhealthy (heartbeat pings failing or 429-evicted), the model is automatically disabled. Set to 0 to disable auto-disable entirely; set to 100 to disable only when all keys fail; set to 1 for aggressive single-key triggering.',
  type: 'number',
  default: 0,
  min: 0,
  max: 100,
  envVar: 'HEARTBEAT_AUTO_DISABLE_PCT',
  effect: 'live',
  group: 'Resilience',
  parentToggle: 'heartbeat_enabled',
}
```

### 4.3 Changes to `events.ts`

Add new `LiveEvent` variant:

```typescript
| { type: 'heartbeat.auto_disable'; provider: string; model: string; modelDbId: number; totalKeys: number; unhealthyKeys: number; threshold: number; at: number }
```

### 4.4 Changes to `client/src/components/live-events.tsx`

Add interface:

```typescript
interface HeartbeatAutoDisableEvent extends TimestampOnly {
  type: 'heartbeat.auto_disable';
  provider: string;
  model: string;
  modelDbId: number;
  totalKeys: number;
  unhealthyKeys: number;
  threshold: number;
}
```

Add to `LiveEvent` union.

Add render case:

```typescript
case 'heartbeat.auto_disable':
  const rId = shortId(evt.modelDbId);
  return {
    id: 'hb',
    ts,
    kind: 'warn',
    text: `🤖 [${rId}] Auto-disabled ${evt.provider}/${evt.model}: ${evt.unhealthyKeys}/${evt.totalKeys} keys unhealthy (threshold ${evt.threshold}%)`
  };
```

### 4.5 Changes to Models Page (`client/src/pages/ModelsPage.tsx` or equivalent)

When a model has `auto_disabled_at !== null`, render a `🤖 auto` badge next to the model name.

The `GET /api/models` endpoint needs to include `auto_disabled_at` in its response. If the SELECT is `m.*`, the column is included automatically once the migration adds it. If explicit columns are listed, add `m.auto_disabled_at`.

### 4.6 Files NOT Changed

- `server/src/services/router.ts` — no routing changes
- `server/src/services/ratelimit.ts` — no rate-limit changes
- `server/src/services/degradation.ts` — degradation still runs independently
- `server/src/services/key-exhaustion.ts` — exhaustion still runs independently
- `server/src/services/scoring.ts` — scoring still runs independently
- `server/src/services/fallback.ts` — fallback chain still works (disabled models are naturally excluded by `models.enabled = 1` in the JOIN)

### 4.7 Relationship to Other Specs (Detailed)

| Spec | Shared File | Interaction |
|---|---|---|
| `provider-health-heartbeat` | `heartbeat.ts` | `evaluateAutoDisable()` added to same file; runs after `runCycle()` pings |
| `429-key-exclusion` | `heartbeat.ts`, `proxy.ts` | Evicted keys (`healthy: false`) are counted by `evaluateAutoDisable()`; no code sharing beyond `keyHealthMap` |
| `dynamic-degradation` | None | Degradation penalty and auto-disable are independent; a model can be both degraded and auto-disabled |
| `provider-outage-fast-fail` | None | Fast-fail is per-request within a single routing attempt; auto-disable is post-cycle across all keys |
| `per-model-enabled-only` | `models.ts` route | Both modify the models endpoint; auto-disable adds `auto_disabled_at` column |
| `smart-routing-thresholds` | None | Threshold scoring doesn't affect auto-disable counting |

---

## 5. Worked Example

**Scenario**: 4 keys for OpenAI, 3 unhealthy (2 failed heartbeat + 1 evicted by 429)

```
keyHealthMap:
  key#1 → { healthy: false, lastError: '429 rate limit' }      ← evicted by spec 1
  key#2 → { healthy: false, lastError: 'ping failed: 401' }    ← heartbeat ping fail
  key#3 → { healthy: false, lastError: 'ping failed: 404' }    ← heartbeat ping fail
  key#4 → { healthy: true }                                      ← OK

threshold = 50%

evaluateAutoDisable(modelDbId=5, 'openai'):
  allKeys = [1, 2, 3, 4] (enabled=1)
  total = 4
  unhealthy = 3 (keys 1, 2, 3)
  pct = (3/4) * 100 = 75%
  75% >= 50% → DISABLE model 5

  UPDATE models SET enabled = 0, auto_disabled_at = datetime('now')
    WHERE id = 5 AND enabled = 1

  publish('heartbeat.auto_disable', {
    provider: 'openai', model: 'gpt-4o', modelDbId: 5,
    totalKeys: 4, unhealthyKeys: 3, threshold: 50, at: Date.now()
  })

Result: Model 5 is disabled. It won't appear in future fallback chain queries.
Dashboard shows: "gpt-4o 🤖 auto" (with auto_disabled_at timestamp tooltip)
```

---

## 6. Edge Cases

### 6.1 Single Key for a Model

With threshold=50% and 1 key: if that key is unhealthy → 100% ≥ 50% → model auto-disabled. If the key is healthy → 0% < 50% → model stays enabled. Correct.

### 6.2 Two Keys, One Unhealthy

With threshold=50% and 2 keys, 1 unhealthy: 50% ≥ 50% → model auto-disabled. At threshold=51%: 50% < 51% → model stays enabled. The boundary is inclusive.

### 6.3 Threshold = 100 (All Keys Must Fail)

At threshold=100: all keys must be unhealthy. A single healthy key keeps the model alive. This is the most conservative setting.

### 6.4 Operator Disables Before Auto-Disable

If the operator manually disables a model (`enabled = 0`), the `AND enabled = 1` clause prevents `evaluateAutoDisable()` from running the UPDATE again. No event is emitted. The `auto_disabled_at` column remains NULL (manual disable).

### 6.5 All Keys Deleted

If `api_keys` has no enabled keys for a platform, `total = 0`, and `evaluateAutoDisable()` returns `null` (no conclusion). A model with zero keys cannot be evaluated — it might be a new model with keys pending import.

### 6.6 Heartbeat Disabled

When `isHeartbeatEnabled()` returns `false`, `runCycle()` never runs, so `evaluateAutoDisable()` is never called. The feature is completely inert.

### 6.7 Model on Multiple Platforms

A model can only belong to one platform (one provider). The keys query is `WHERE platform = ?`, so it naturally scopes to the correct key pool.

### 6.8 Model Re-Enabled, Then Keys Fail Again

The operator re-enables the model (`enabled = 1`, `auto_disabled_at = NULL`). On the next heartbeat cycle, if the threshold is still exceeded, the model gets auto-disabled again. This is correct — the operator needs to fix the underlying key issue before re-enabling.

### 6.9 Auto-Disable During Startup Prewarm

The prewarm cycle is `runCycle(true)` (skip activity gate). After prewarm pings complete, `evaluateAutoDisable()` runs. Models with dead keys get disabled within seconds of startup. Cold keys are treated as unhealthy, but they'll be pinged during prewarm — so keys that respond successfully won't count as unhealthy.

---

## 7. Testing Strategy

### 7.1 Unit Tests (`heartbeat.test.ts`)

- Threshold exceeded → model disabled, event emitted
- Threshold not met → model stays enabled, no event
- Already disabled model → no-op, no event, no DB write
- Zero keys for platform → returns null, no action
- Cold keys counted as unhealthy when heartbeat enabled
- Custom threshold via env var

### 7.2 Integration Tests

- Full cycle: ping fails → key unhealthy → evaluateAutoDisable → model disabled
- 429 eviction → key unhealthy → next cycle auto-disables model
- Re-enable model → next cycle with all keys healthy → model stays enabled

### 7.3 Dashboard Tests

- `HeartbeatAutoDisableEvent` renders correctly in live-events
- Models page shows 🤖 auto badge when `auto_disabled_at` is set
- Models page does NOT show badge when `auto_disabled_at` is null

### 7.4 Edge Case Tests

- Single key model, threshold=50
- Two keys, one unhealthy, boundary: threshold=50 vs 51
- All keys deleted
- Heartbeat disabled
