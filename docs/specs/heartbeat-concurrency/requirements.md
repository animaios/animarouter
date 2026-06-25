# Heartbeat Concurrency — Requirements

## 1. Problem Statement

The heartbeat system pings every API key to maintain per-key health data (`keyHealthMap`). Currently, pings run **sequentially with a configurable stagger** (default: 2 seconds between each ping). The cycle time is:

```
cycle_time ≈ K_total × ping_latency + (K_total - 1) × stagger_ms
```

With defaults (10 providers × 5 keys each = 50 keys, 2s stagger, ~3s per ping):

| Scenario | Keys | Per-ping | Stagger | Cycle time |
|---|---|---|---|---|
| Small deployment | 10 | 3s | 2s | 48s |
| Medium deployment | 50 | 3s | 2s | 248s (4 min) |
| Large deployment | 100 | 3s | 2s | 498s (8 min) |

This was acceptable when the only consequence of a slow cycle was slightly stale health data. However, the **429 Key Exclusion** and **Heartbeat Auto-Disable** specs have changed the stakes:

1. **429-evicted keys** remain unhealthy until the *next* successful heartbeat ping confirms they can serve traffic again. A 4-minute cycle means an evicted key might be excluded from routing for 4 minutes — even if the rate limit subsides in 30 seconds.

2. **Auto-disable** only triggers *after* a cycle completes. A model with 0 healthy keys wastes routing attempts for the entire duration of the cycle. On a 4-minute cycle, that's 4 minutes of latency and wasted retries on every user request.

3. **Prewarm startup** runs one initial cycle (`skipGate=true`). A slow sequential prewarm delays the server becoming fully operational.

The stagger was designed to avoid "thundering herd" bursts against a single provider's API. With batched parallelism, we can get near-instant cycle time without triggering provider rate limits — because the burst is bounded per-platform.

### Concrete impact of slow cycles

| User-visible effect | Cycle time | Impact |
|---|---|---|
| Key evicts on 429, subsides in 30s | 4 min | Key excluded for 3.5 min longer than necessary |
| Model with all dead keys | 4 min | 4 min of routing failures before auto-disable |
| Server restart with 50 keys | 4 min | Prewarm takes 4 min before keys are ready |
| Dashboard health data | 4 min stale | Operator sees outdated health for 4 min |

---

## 2. User Stories

### US-1: Near-Instant Cycle Completion
**As an operator**, I want heartbeat cycles to complete in seconds, not minutes, so that evicted keys are restored quickly and auto-disable fires promptly.

### US-2: Bounded Burst Per Provider
**As an operator**, I want to control how many concurrent pings can hit the same provider at once, so I don't get rate-limited by my provider while trying to check my keys.

### US-3: Backward Compatible Migration
**As an operator**, I want my existing configuration (`heartbeat_stagger_ms`) to continue working after upgrading, or at least have a clear migration path.

### US-4: Configurable Concurrency
**As an operator**, I want to tune the concurrency level per deployment — more concurrency for faster cycles, less for conservative deployments.

---

## 3. Functional Requirements

### FR-1: Batched Parallel Pings

Replace the sequential ping loop (`for await` with stagger) with batched concurrent pings:

```typescript
// Current (sequential with stagger):
for (let i = 0; i < pingTasks.length; i++) {
  const task = pingTasks[i];
  try {
    await pingKey(task.platform, task.modelDbId, task.modelId, task.key, pingTimeoutMs);
  } catch (e) { /* ... */ }
  if (staggerMs > 0 && i < pingTasks.length - 1) {
    await sleep(staggerMs);
  }
}

// New (batched concurrent):
const concurrency = getHeartbeatConcurrency();
for (let i = 0; i < pingTasks.length; i += concurrency) {
  const batch = pingTasks.slice(i, i + concurrency);
  await Promise.allSettled(batch.map(task =>
    pingKey(task.platform, task.modelDbId, task.modelId, task.key, pingTimeoutMs)
      .catch(e => console.error(`[Heartbeat] Ping error for key#${task.key.id}:`, e))
  ));
}
```

### FR-2: Per-Platform Burst Limit

The concurrency limit applies globally across all providers, not per provider. This means:
- With concurrency=4 and 50 keys across 5 providers, each batch of 4 may include keys from different providers
- No provider gets more than `concurrency` concurrent pings
- If all 50 pings are for OpenAI, they fire 4 at a time — safe for any provider's rate limits

| Setting | Default | Description |
|---|---|---|
| `heartbeat_concurrency` | `4` | Max concurrent ping requests per batch. Range 1–16. |

### FR-3: Stagger Deprecation

The existing `heartbeat_stagger_ms` setting is **deprecated** but kept for backward compatibility:
- When `heartbeat_concurrency` is not explicitly set by the user, `heartbeat_stagger_ms` continues to work (no behavior change)
- When `heartbeat_concurrency` IS explicitly set, stagger is ignored
- A future spec removal can drop `heartbeat_stagger_ms` entirely

**Detection heuristic**: If the user has changed `heartbeat_stagger_ms` from its default (2000), they are using the old behavior. The system respects it. If they haven't, the system auto-migrates to concurrent mode with the default concurrency=4.

Better approach: just ship the new setting. Both settings coexist; `stagger_ms` simply becomes a no-op when concurrency > 1. This avoids any heuristic complexity.

### FR-4: Idempotent Pings

`pingKey()` already sets `healthy: true/false` in `keyHealthMap` based on its own result. Concurrent pings to the same key don't interfere because:
- Each key appears only once in `pingTasks` (`seenKeys` dedup)
- Each `keyHealthMap.set()` is a synchronous Map operation — no race condition
- Last-writer-wins is fine: the latest ping result for a key is the authoritative one

### FR-5: Error Handling

`Promise.allSettled()` instead of `Promise.all()` — an individual ping failure must not abort the entire batch. The catch handler per-key (from `pingKey()` internal try/catch) and the `allSettled` surface handler ensure:
- A single 500 from a provider doesn't cancel pings to other providers
- Each key gets independent `keyHealthMap` updates
- The batch completes as fast as the slowest key's ping timeout

### FR-6: Concurrency Setting

New feature setting:

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

## 4. Non-Functional Requirements

### NFR-1: Cycle Time Improvement

| Configuration | 10 keys | 50 keys | 100 keys |
|---|---|---|---|
| Sequential (stagger 2s, ping 3s) | 48s | 248s | 498s |
| Concurrent (concurrency=4, ping 3s) | 9s | 39s | 78s |
| Concurrent (concurrency=8, ping 3s) | 6s | 21s | 42s |
| Concurrent (concurrency=16, ping 3s) | 3s | 12s | 24s |

### NFR-2: Backward Compatibility
- Default behavior changes from sequential (stagger 2s) to concurrent (concurrency=4)
- Existing customization (`heartbeat_stagger_ms` ≠ default) still works if the user doesn't set `heartbeat_concurrency`
- No changes to `keyHealthMap` shape, `isKeyHealthy()`, `markKeyUnhealthy()`, or any other export

### NFR-3: Performance Overhead
- `Promise.allSettled()` over a small batch (≤16) — zero meaningful overhead
- Multiple batches still apply the `cycleInProgress` lock (unchanged)
- No new DB queries or I/O per cycle

### NFR-4: Predictability
- All pings in a batch start simultaneously — the slowest key determines batch duration
- Keys are not ordered by priority within a batch (the batch is just a slice of `pingTasks` which is already ordered by model priority)
- No ordering guarantees are needed: `keyHealthMap` is simply a Map of key → health regardless of ping order

---

## 5. Out of Scope

- **Dynamic concurrency** (auto-scaling based on provider response times) — static config only
- **Per-provider concurrency** — one global setting
- **Cancellation** — no AbortController propagation (`pingTimeoutMs` handles individual timeouts)
- **Removal of `heartbeat_stagger_ms`** — preserved for backward compatibility, removed in a future spec
