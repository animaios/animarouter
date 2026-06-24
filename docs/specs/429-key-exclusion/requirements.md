# 429 Key Exclusion — Requirements

## 1. Problem Statement

When a provider key returns a `429` (Rate Limit Exceeded) or `402` (Payment Required), the current system benches the **model+key pair** via cooldowns (escalating: 2min → 10min → 1h → 24h). The key remains eligible for routing to *other* models that share the same platform. Two issues arise:

1. **Wasted retries on the same key**: A key that is rate-limited on one model is likely at its global account throttle (many providers enforce a shared RPM/RPD across *all* models on the same key). Retrying the key on a different model still hits the same limit.

2. **Graduated cooldown isn't enough**: Even with the escalating cooldown (2min → 10min → 1h → 24h), a day-quota-exhausted key is benched for a day *at most*. The proxy still tries it after the cooldown expires — but if the daily quota hasn't reset, the first request of the new day wastes a retry discovering the same exhaustion.

The **heartbeat system** (`provider-health-heartbeat` spec) already maintains a per-key health map (`keyHealthMap` in `heartbeat.ts`). When the heartbeat is enabled, the router (`router.ts`) already **only routes to healthy keys** — it completely ignores unhealthy keys. But currently, the only thing that flips a key to unhealthy is a **heartbeat ping failure**. Real request traffic (429s) never updates the key's health status.

**Gap**: A key that 429s during real traffic remains "healthy" to the router. It continues to be routed to until the cooldown-plus-exhaustion loop eventually benches it — wasting retry attempts in the process.

---

## 2. User Stories

### US-1: Immediate Key Eviction on 429
**As an operator**, when a provider key returns a 429 during a real request, I want that key to be **immediately removed from the healthy pool** — no more retries on that key for any model until the heartbeat confirms it can serve traffic again.

### US-2: Heartbeat-Only Recovery
**As an operator**, once a key is evicted due to 429, I want the **only** path back to the healthy pool to be a successful heartbeat ping. Cooldown expiry must NOT restore the key's health — only a confirmed successful ping can.

### US-3: Works with Heartbeat Enabled
**As an operator**, I want this feature to be automatically active when the heartbeat is enabled. No separate toggle needed — it's a natural extension of the per-key health system.

### US-4: Graceful Degradation When Heartbeat Disabled
**As an operator**, if the heartbeat is disabled, I want the existing cooldown-based recovery to continue working unchanged. No regressions for operators who haven't opted into the heartbeat.

### US-5: Observable Evictions
**As an operator**, I want to see 429-driven key evictions in the live-event stream so I can distinguish "key rate-limited (evicted)" from "key exhausted (normal cooldown)".

### US-6: Also Covers 402 (Payment Required)
**As an operator**, I want a key that returns 402 (out of credits) to be evicted identically — this is an even stronger signal of key unavailability than a transient 429.

---

## 3. Functional Requirements

### FR-1: Immediate Key Eviction
When a request to a provider key returns a `429` or `402` error (classified as `'minor'` by `classifyError()`), and the heartbeat is enabled (`heartbeat_enabled = true`), the proxy shall immediately mark that key as unhealthy via `markKeyUnhealthy(keyId)` in the heartbeat's per-key health map.

**Trigger point**: Inside the proxy's retry loop (`proxy.ts`), when a retryable error is caught and `classifyError(err) === 'minor'` (covers both 429 and 402), the eviction happens **before** the next retry attempt on the same key.

**Eviction scope**: Per-key. The key is unhealthy for ALL models on that platform — not just the model that returned the 429.

```typescript
// Pseudo-code — placed inside the catch block before 'continue keyRetry'
if (classifyError(err) === 'minor' && isHeartbeatEnabled()) {
  markKeyUnhealthy(route.keyId);
  publish({
    type: 'routing.key_evicted',
    id: requestId,
    provider: route.platform,
    keyId: route.keyId,
    model: route.modelId,
    reason: classifyError(err) === 'minor' ? 'rate_limited' : 'payment_required',
    at: Date.now(),
  });
  break keyRetry;  // Don't waste remaining retries on an evicted key
}
```

### FR-2: Heartbeat-Only Recovery Path
An evicted key (`healthy: false` in `keyHealthMap`) shall ONLY be restored to the healthy pool by a successful heartbeat ping (`pingKey()` in `heartbeat.ts`). Specifically:
- Cooldown expiry must NOT change `keyHealthMap` entries
- `clearExhausted()` must NOT change `keyHealthMap` entries
- `isKeyHealthy(keyId)` returns `false` for any evicted key until heartbeat proves otherwise

The heartbeat already does the right thing — when `pingKey()` succeeds, it sets `keyHealthMap.set(keyId, { healthy: true, ... })`. No changes needed to heartbeat's recovery path.

### FR-3: Active Only When Heartbeat Enabled
The eviction path (`FR-1`) is gated on `isHeartbeatEnabled()`. When heartbeat is disabled:
- `markKeyUnhealthy()` is a no-op
- Keys rely on the existing cooldown + exhaustion system for recovery
- Backward compatible — zero behaviour change for existing deployments

### FR-4: Event Emission
Add a new event variant to the `LiveEvent` union:

```typescript
| { type: 'routing.key_evicted'; id: string; provider: string; keyId: number; model: string; reason: 'rate_limited' | 'payment_required'; at: number }
```

The event shall be emitted exactly once per key eviction (not on every retry attempt).

The dashboard (`live-events.tsx`) shall render this event with a `warn` kind:

```typescript
case 'routing.key_evicted':
  return { id: evt.id, ts, kind: 'warn',
    text: `🚫 Key #${evt.keyId} evicted (${evt.reason === 'rate_limited' ? '429 rate limit' : '402 out of credits'}) on ${evt.provider}/${evt.model}` };
```

### FR-5: `markKeyUnhealthy()` Export
Add to `heartbeat.ts`:

```typescript
/** Mark a key as unhealthy in the per-key health map. The key will be excluded
 *  from routing until a successful heartbeat ping restores it.
 *  No-op when heartbeat is disabled. */
export function markKeyUnhealthy(keyId: number, error?: string): void {
  if (!isHeartbeatEnabled()) return;
  const prev = keyHealthMap.get(keyId);
  keyHealthMap.set(keyId, {
    penalty: (prev?.penalty ?? 0) + 1,
    lastPingAt: Date.now(),
    healthy: false,
    lastError: error ?? 'evicted by traffic 429',
  });
}
```

### FR-6: Integration with Key Exhaustion
Eviction does NOT replace key exhaustion — both run. When a key is evicted mid-retry (`break keyRetry`):

1. `markKeyUnhealthy(keyId)` — key excluded from healthy pool
2. `markExhausted(keyId, ...)` — key marked exhausted for this request (avoids re-selection within the same request)
3. `skipKeys.add(skipId)` — key skipped for this (platform, model) pair
4. `setCooldown(...)` — safety-net cooldown persists in case heartbeat is ever disabled at runtime
5. `recordFailure(modelDbId, tier)` — model-level degradation still accumulates

The key exhaustion block (`L1252-1272`) already handles steps 2-5. Eviction (step 1) is added at the same integration point as the fast-fail check (`L1274`).

### FR-7: Feature Settings

No new settings needed. The feature is gated on `heartbeat_enabled`:

| Setting | Effect on 429 Key Exclusion |
|---|---|
| `heartbeat_enabled = true` (default: `false`) | 429/402 eviction active; heartbeat-only recovery |
| `heartbeat_enabled = false` (default) | Feature disabled; existing cooldown recovery |

If the dashboard eventually wants a toggle, add `key_eviction_enabled` as a child of `heartbeat_enabled`. Not needed for the initial implementation.

### FR-8: No New DB State

The `keyHealthMap` in `heartbeat.ts` is entirely in-memory. No new columns, tables, or migrations. On restart, `keyHealthMap` is empty — cold keys are `healthy: false` when heartbeat is enabled (`isKeyHealthy` returns `false` for unknown keys). This means:
- A restart after an eviction doesn't resurrect the evicted key
- The startup prewarm cycle (`runCycle(true)`) re-pings all keys and restores health for any that respond

---

## 4. Non-Functional Requirements

### NFR-1: Backward Compatibility
- When heartbeat is disabled (default): zero behaviour change. Existing cooldown + exhaustion controls all 429 recovery.
- When heartbeat is enabled: keys that 429 during real traffic are evicted, consistent with the user's expectation that the heartbeat fully manages key health.
- No changes to the routing algorithm itself — `isKeyHealthy()` already provides the gating.

### NFR-2: Performance
- `markKeyUnhealthy()` is a single `Map.set()` — O(1), no I/O
- `publish()` is a fire-and-forget event bus call — O(N_subscribers), but N ≤ 8
- No new DB queries during the request path

### NFR-3: Correctness
- A key that 429s on model A is evicted for ALL models — correct because most providers share rate limits across models on the same key
- A key evicted mid-retry still gets the normal key-exhaustion handling (cooldown, recordFailure) — both mechanisms run independently
- A successful heartbeat ping is the ONLY path to recovery, even if the cooldown has expired
- If heartbeat is disabled mid-runtime (not possible currently, `heartbeat_enabled` is `restart`-effect), the feature cleanly disables

### NFR-4: Observability
- `routing.key_evicted` event distinguishable from `routing.key_exhausted` in the live feed
- `lastError` on `KeyHealth` captures the error message for dashboard/debug API visibility

### NFR-5: Pinned Model Interaction
When the pinned model's last healthy key is evicted, `routeRequest` finds `healthyKeys = []` and, in `pinMode`, throws `PINNED_MODEL_EXHAUSTED` → 429 to client. Correct — immediate error, no wasted retries.

---

## 5. Out of Scope

- **5xx eviction** — 5xx errors are provider-outage signals, not key-limitation signals. The fast-fail spec already handles within-request provider-level 5xx detection. Degradation handles cross-request 5xx backoff.
- **Dashboard health panel** — The key health map data is already available via `getAllKeyHealth()` for a future dashboard panel. Not part of this spec.
- **Per-model key eviction** — Since most providers share limits across models on a key, eviction is per-key (covers all models). If a future provider uses per-model key limits, this can be refined.
- **Rate-limit header inspection** — We only check the HTTP status code, not `Retry-After` headers or `X-RateLimit-*` headers. The heartbeat's own timing is sufficient for recovery.
- **Alerting** — No external alerting (Slack, PagerDuty) triggered by evictions. Only the live-event stream.