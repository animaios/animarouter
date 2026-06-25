# Heartbeat Concurrency — Design Document

## 1. Architecture Overview

### Integration with Existing Systems

This spec modifies a single function (`runCycle()` in `heartbeat.ts`) by replacing its sequential ping loop with batched concurrent pings. Everything else — `keyHealthMap`, `pingKey()`, `isKeyHealthy()`, `evaluateAutoDisable()`, the event system, the routing path — remains unchanged.

```
┌──────────────────────────────────────────────────────────┐
│                   runCycle()                               │
│                                                            │
│  1. Activity gate (unchanged)                              │
│  2. Query enabled models + keys (unchanged)                │
│  3. Build pingTasks array (unchanged)                      │
│  4. ┌────────────────────────────────────────────────┐    │
│    │ Ping keys: SEQUENTIAL → CONCURRENT BATCHES      │    │
│    │   Before: for-await with stagger                 │    │
│    │   After:  Promise.allSettled per batch of N      │    │
│    └────────────────────────────────────────────────┘    │
│  5. Auto-disable evaluation (unchanged)                    │
│  6. Clear cycleInProgress (unchanged)                      │
└──────────────────────────────────────────────────────────┘
```

### Relationship to Other Specs

| Spec | Interaction |
|---|---|
| `provider-health-heartbeat` | Direct modification — replaces the ping loop in `runCycle()` |
| `429-key-exclusion` | Accelerates recovery — evicted keys get restored on the NEXT cycle, which now completes 10-50x faster |
| `heartbeat-auto-disable` | Accelerates disable — dead models are detected and disabled within seconds instead of minutes |
| `dynamic-degradation` | Independent — no change to degradation scoring |
| All others | No interaction |

---

## 2. Core Data Model

### 2.1 No New Data Structures

No new data structures. The only change is to the control flow within `runCycle()`.

- `keyHealthMap` — unchanged
- `pingTasks` array — unchanged (same collection logic)
- `pingedModels` set — unchanged

### 2.2 Configuration

New feature setting `heartbeat_concurrency` (replaces the behavioral role of `heartbeat_stagger_ms`):

```typescript
{
  key: 'heartbeat_concurrency',
  label: 'Heartbeat Concurrency',
  description:
    'Maximum number of concurrent heartbeat ping requests. Higher values complete cycles faster but may cause burst-rate-limit issues with less forgiving providers. Default is 4 — a safe middle ground. Set to 1 to restore sequential behavior.',
  type: 'number',
  default: 4,
  min: 1,
  max: 16,
  envVar: 'HEARTBEAT_CONCURRENCY',
  effect: 'restart',
  group: 'Resilience',
}
```

---

## 3. Algorithm Details

### 3.1 `readConfig()` — Add Concurrency

```typescript
// New module-level config variable
let _concurrency: number | null = null;

function readConfig() {
  if (_enabled === null) {
    _enabled = getFeatureSetting('heartbeat_enabled') as boolean;
    _intervalMs = (getFeatureSetting('heartbeat_interval_min') as number) * 60 * 1000;
    _activityWindowMs = (getFeatureSetting('heartbeat_activity_window_min') as number) * 60 * 1000;
    _pingTimeoutMs = getFeatureSetting('heartbeat_timeout_ms') as number;
    _staggerMs = getFeatureSetting('heartbeat_stagger_ms') as number;
    _concurrency = getFeatureSetting('heartbeat_concurrency') as number;  // NEW
  }
  return {
    enabled: _enabled, intervalMs: _intervalMs!, activityWindowMs: _activityWindowMs!,
    pingTimeoutMs: _pingTimeoutMs!, staggerMs: _staggerMs!, concurrency: _concurrency!,  // NEW
  };
}
```

`resetHeartbeatConfig()` also resets `_concurrency = null`.

### 3.2 `runCycle()` — Replace Staggered Loop

The ping section changes from:

```typescript
// ── Current: sequential with stagger ──
for (let i = 0; i < pingTasks.length; i++) {
  const task = pingTasks[i];
  try {
    await pingKey(task.platform, task.modelDbId, task.modelId, task.key, pingTimeoutMs);
  } catch (e) {
    console.error(`[Heartbeat] Ping error for key#${task.key.id} on ${task.platform}/${task.modelId}:`, e);
  }
  if (staggerMs > 0 && i < pingTasks.length - 1) {
    await sleep(staggerMs);
  }
}
```

To:

```typescript
// ── New: concurrent batches ──
const { concurrency } = readConfig();
for (let i = 0; i < pingTasks.length; i += concurrency) {
  const batch = pingTasks.slice(i, i + concurrency);
  await Promise.allSettled(batch.map(task =>
    pingKey(task.platform, task.modelDbId, task.modelId, task.key, pingTimeoutMs)
      .catch(err => {
        console.error(`[Heartbeat] Ping error for key#${task.key.id} on ${task.platform}/${task.modelId}:`, err);
      })
  ));
}
```

### 3.3 Stagger Migration Heuristic

The `readConfig()` function uses this logic to handle the transition:

```
if _concurrency is not null (user explicitly set it):
  → use concurrent mode at _concurrency level
  → stagger is IGNORED (not applied in the loop)
else if _staggerMs changed from default (2000):
  → user customized stagger, respect it: use sequential mode (concurrency=1, apply stagger)
  → log a deprecation warning to console once
else:
  → default: concurrent mode at concurrency=4
  → stagger IGNORED
```

Wait — `getFeatureSetting()` always returns the configured or default value, never null. So we can't distinguish "user explicitly set concurrency" from "concurrency is at default."

**Simpler approach**: Three config values are read from `feature-settings.ts`. The `REGISTRY` entry for `heartbeat_concurrency` has `default: 4`. We just read it. If the user set it to anything (even 4 explicitly), it's 4. If they never set it, it's 4.

The behavioral change is:
- **Old default**: stagger 2000ms → sequential, ~40s for 10 keys
- **New default**: concurrency 4 → ~9s for 10 keys

This IS a behavior change on upgrade. But it's a *better* default. If the user wants the old behavior, they set `heartbeat_concurrency = 1`, which restores sequential behavior with zero stagger (fast sequential, no waiting).

The existing `heartbeat_stagger_ms` setting remains in the `REGISTRY` and continues to be read by `readConfig()`, but it's **no longer applied by default**. If the user explicitly sets `heartbeat_concurrency = 1` AND has customized `heartbeat_stagger_ms`, the stagger is still applied conditionally.

**Decision**: Keep it simple. The new `heartbeat_concurrency` setting replaces the *role* of stagger. Both settings coexist in the REGISTRY. The stagger value is read but only used when `concurrency === 1`:

```typescript
if (concurrency === 1 && staggerMs > 0) {
  await sleep(staggerMs);
}
```

This means: if you go concurrent, stagger is meaningless (we're firing in parallel anyway). If you set concurrency=1 (sequential mode), stagger still works as before. Clean, no heuristics.

---

## 4. Integration Points

### 4.1 Changes to `heartbeat.ts`

1. Add `_concurrency` module-level variable (near L92)
2. Add `concurrency` to `readConfig()` return + cache
3. Add `_concurrency = null` to `resetHeartbeatConfig()`
4. Replace the ping loop in `runCycle()` (L239-250) with batched concurrent version
5. Add `getHeartbeatConcurrency()` export (if needed for tests)

### 4.2 Changes to `feature-settings.ts`

Add new registry entry in the `Resilience` group, after `heartbeat_auto_disable_pct`:

```typescript
  {
    key: 'heartbeat_concurrency',
    label: 'Heartbeat Concurrency',
    description:
      'Maximum number of concurrent heartbeat ping requests. Higher values complete cycles faster but may cause burst-rate-limit issues with less forgiving providers. Default is 4 — a safe middle ground. Set to 1 to restore sequential behavior.',
    type: 'number',
    default: 4,
    min: 1,
    max: 16,
    envVar: 'HEARTBEAT_CONCURRENCY',
    effect: 'restart',
    group: 'Resilience',
  },
```

### 4.3 Changes to Events

No new events. The existing `heartbeat.ping` and `heartbeat.cycle_skipped` events are unaffected. The concurrency change only affects the timing of pings, not their schema or emission.

### 4.4 Files NOT Changed

- `server/src/services/events.ts` — no event changes
- `server/src/routes/proxy.ts` — no proxy changes
- `server/src/services/router.ts` — no routing changes
- `server/src/services/ratelimit.ts` — no rate-limit changes
- `server/src/services/degradation.ts` — no degradation changes
- `server/src/services/scoring.ts` — no scoring changes
- `client/src/components/live-events.tsx` — no UI changes (event shape unchanged)
- All DB/migration files — no schema changes

---

## 5. Worked Example

**Setup**: 12 keys across 3 providers. `heartbeat_concurrency = 4`. `pingTimeoutMs = 10000`.

```
pingTasks = [
  { platform: 'openai', key: K1 },
  { platform: 'openai', key: K2 },
  { platform: 'openai', key: K3 },
  { platform: 'openai', key: K4 },
  { platform: 'google', key: K5 },
  { platform: 'google', key: K6 },
  { platform: 'google', key: K7 },
  { platform: 'anthropic', key: K8 },
  { platform: 'anthropic', key: K9 },
  { platform: 'anthropic', key: K10 },
  { platform: 'openai', key: K11 },
  { platform: 'openai', key: K12 },
]

concurrency = 4

Batch 1: K1, K2, K3, K4    → all OpenAI, fire simultaneously → ~3s (slowest ping)
Batch 2: K5, K6, K7, K8    → google×3 + anthropic×1 → ~3s
Batch 3: K9, K10, K11, K12 → anthropic×2 + openai×2 → ~3s

Total: ~9s (vs sequential: ~48s with 3s ping + 2s stagger × 11)
```

**Contrast with sequential**: The same 12 keys with 3s ping + 2s stagger would take 12×3 + 11×2 = 58s.

---

## 6. Edge Cases

### 6.1 Concurrency = 1

When `heartbeat_concurrency = 1`, pings fire sequentially with NO stagger by default. If the user also has a customized `heartbeat_stagger_ms`, the stagger is applied between pings. This restores the original sequential behavior.

### 6.2 Concurrency Exceeds Key Count

If `concurrency > pingTasks.length`, all pings fire in a single batch. This is correct — `pingTasks.slice(0, pingTasks.length)` is just the whole array.

### 6.3 Single Key

With one key total: `batch = [task]`, `Promise.allSettled([pingKey(...)])` — effectively sequential, no wasted parallel overhead.

### 6.4 All Pings Time Out

`Promise.allSettled()` settles when ALL promises settle. If each batch has, say, 4 pings and all 4 time out after `pingTimeoutMs` (10s), the batch completes in 10s. This is correct — each batch takes `max(ping_latency)` time, and every key gets its full `pingTimeoutMs` to respond.

### 6.5 Some Pings Succeed, Some Fail per Batch

`Promise.allSettled()` returns `{status: 'fulfilled', value}` or `{status: 'rejected', reason}` for each promise. The `.catch()` inside the map handles individual logging and prevents unhandled rejections. The batch always completes.

### 6.6 PingKey Throws Synchronously

`pingKey()` is async and its internal try/catch already handles errors. But if something throws synchronously, the `.catch()` on each `pingKey()` call in the map catches it. Double protection.

### 6.7 Upgrading from Sequential Default

Existing deployment with `heartbeat_stagger_ms = 2000` (default) and no `heartbeat_concurrency` set. On upgrade:
- `getFeatureSetting('heartbeat_concurrency')` returns `4` (default)
- `readConfig()` uses `concurrency = 4`
- Stagger value is read but not applied (concurrency > 1)
- Behavior changes from sequential to concurrent

**Is this safe?** Yes, because:
- The network characteristics are unchanged (same `pingTimeoutMs`, same provider endpoints)
- Only the parallelism of pings changes
- The old deploy had stagger=2000 to avoid thundering-herd. With concurrency=4, the herd is 4 concurrent requests — far below any provider's per-second limit
- The `keyHealthMap` is Map-based and does not care about write ordering

### 6.8 `resetHeartbeatConfig()` — Test Cache Clear

The existing pattern of `resetHeartbeatConfig()` (called in tests after changing a setting) must also reset `_concurrency`. If not, tests that change `heartbeat_concurrency` via `process.env` will see cached values.

---

## 7. Testing Strategy

### 7.1 Unit Tests

- Verify `readConfig()` returns `concurrency: 4` by default
- Verify setting `HEARTBEAT_CONCURRENCY=8` env var yields `concurrency: 8`
- Verify `concurrency=1` with stagger works (sequential fallback)
- Verify `concurrency` is clamped to 1–16 range

### 7.2 Integration Tests

- Mock 3 pings with different latencies (1s, 2s, 3s). With `concurrency=3`, total time should be ~3s (not 6s sequential).
- Verify `keyHealthMap` is correctly populated after concurrent batch completes
- Verify `Promise.allSettled` handles mixed success/failure correctly

### 7.3 Stagger Migration Tests

- Default config: `getFeatureSetting('heartbeat_stagger_ms')` is still readable — verify readConfig() includes it
- `concurrency=1` + `staggerMs=2000`: verify stagger fires between batches (sequential behavior)
- `concurrency=4` + `staggerMs=2000`: verify stagger is NOT applied

### 7.4 Regression Tests

- Full cycle with auto-disable (spec 2) still works — auto-disable evaluation runs after concurrent pings
- Keys evicted by 429 are restored on the next concurrent cycle
- Startup prewarm cycle completes faster (indirect test, measure cycle time)
