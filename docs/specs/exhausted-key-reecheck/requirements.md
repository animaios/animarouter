# Exhausted-Key Recheck — Requirements

## 1. Problem Statement

When a key hits a rate limit (429) or payment error (402), the heartbeat marks it unhealthy via `markKeyUnhealthy()` and the router avoids it. The key stays benched until the **next scheduled heartbeat cycle** (default: every 10 minutes) *happens to* re-ping it and discover it's healthy again.

The gap between exhaustion and recheck is unbounded. A key that was 429'd at T=0 won't be re-evaluated until the regular heartbeat cycle fires (up to 10 minutes later) — and only if that cycle includes the key in its sweep. This means:

- **Keys recover too slowly**: A transient 429 (RPM burst) typically resolves in seconds, but the key stays benched for minutes.
- **Recovery is accidental, not intentional**: The regular heartbeat pings all keys uniformly — it doesn't prioritize keys that *just* failed. An exhausted key has the same priority as a healthy one in the next cycle.
- **Operators work around it manually**: Clicking "Check" on each key in the dashboard or using `pokeKey()` to force a recheck — but only because they notice degraded throughput.

The system needs a **directed recheck timer** that proactively re-pings exhausted keys within a configurable time window, independent of the general heartbeat cycle.

## 2. User Stories

### US-1: Timely Exhausted-Key Recovery
**As an operator**, I want exhausted keys to be automatically re-checked within a configurable window (e.g., 90 seconds), so transient rate-limits self-resolve without manual intervention.

### US-2: Configurable Recheck Interval
**As an operator**, I want to control how quickly exhausted keys are re-tested, so I can balance recovery speed against upstream API budget for keys on tight RPM quotas.

### US-3: No Wasted Pings on Healthy Keys
**As an operator**, I want the recheck to only target keys that are currently unhealthy/exhausted — healthy keys should NOT be re-pinged, so I don't waste API budget on keys that are already known-good.

### US-4: Dashboard Visibility
**As an operator**, I want to see the recheck interval on the settings page and recheck events in the live-event stream, so I can verify the feature is working.

### US-5: Graceful Degrade When Disabled
**As an operator**, when heartbeat is disabled, the recheck timer should not run — the existing cooldown system handles recovery in that mode (backward compatible).

### US-6: No Interference with Regular Heartbeat
**As a user**, the recheck must not conflict with the regular heartbeat cycle. If a regular cycle just pinged the key, the recheck should skip it.

## 3. Functional Requirements

### FR-1: Exhausted-Key Recheck Timer
When a key is marked unhealthy via `markKeyUnhealthy()`, schedule a **per-key recheck timer** that fires after `heartbeat_exhausted_recheck_sec` seconds (default: 90). When the timer fires:

1. Call `pingKey()` for the exhausted key (re-use the existing heartbeat ping logic).
2. If the ping succeeds, mark the key healthy — it immediately re-enters the routing pool.
3. If the ping fails, the key stays unhealthy. Schedule another recheck (up to `heartbeat_exhausted_max_rechecks` retries, default: 3).
4. After max rechecks are exhausted, stop retrying — the next regular heartbeat cycle will pick it up.

### FR-2: Recheck Respects Per-Key Model
The recheck uses the same model-selection logic as `pokeKey()`: pick the highest-priority model for the key's platform from the fallback chain. If no eligible model exists, skip the recheck.

### FR-3: No Concurrent Recheck for Same Key
If a recheck timer is already pending for a key (e.g., the key was 429'd twice in quick succession), do NOT schedule a duplicate timer. The existing pending timer is sufficient — it will fire and test the key.

### FR-4: Recheck Skips Recently-Pinged Keys
If the key was pinged (by any mechanism — regular heartbeat, `pokeKey`, or a prior recheck) within the last `heartbeat_exhausted_recheck_sec / 2` seconds, skip this recheck. This avoids redundant pings when the regular heartbeat cycle just tested the key.

### FR-5: Recheck Cancels on Key Disable/Delete
If a key is disabled (`enabled = 0`) or deleted while a recheck timer is pending, cancel the timer. No point pinging a disabled key.

### FR-6: Event Emission
Each recheck ping emits a `heartbeat.recheck` event via the existing `publish()` system:

```typescript
{ type: 'heartbeat.recheck'; keyId: number; provider: string; model: string; success: boolean; latencyMs: number; attempt: number; error?: string; at: number }
```

This is separate from `heartbeat.ping` so the dashboard can distinguish scheduled health checks from targeted recovery checks.

### FR-7: Dashboard Rendering
The client's `live-events.tsx` shall render `heartbeat.recheck` events with a distinct visual indicator (⚡ icon). Success renders as `info` kind; failure as `warn` kind.

### FR-8: Configuration

| Setting Key | Label | Type | Default | Min | Max | Env Var | Effect | Group |
|---|---|---|---|---|---|---|---|---|
| `heartbeat_exhausted_recheck_sec` | Exhausted-Key Recheck (sec) | number | 90 | 15 | 600 | `HEARTBEAT_EXHAUSTED_RECHECK_SEC` | restart | Resilience |
| `heartbeat_exhausted_max_rechecks` | Max Recheck Attempts | number | 3 | 1 | 10 | `HEARTBEAT_EXHAUSTED_MAX_RECHECKS` | restart | Resilience |

Both settings are children of `heartbeat_enabled` — they only apply when the heartbeat is active. When heartbeat is disabled, no recheck timers are created.

### FR-9: Pings Do Not Count Toward Rate Limits
Same rule as regular heartbeat pings (FR-6 from provider-health-heartbeat): recheck pings must NOT call `recordRequest()`, `recordTokens()`, `setCooldown()`, or insert into the `requests` table.

### FR-10: Recheck Pings Update Per-Key Health
A successful recheck ping updates the `keyHealthMap` exactly like a successful regular heartbeat ping — penalty resets to 0, `healthy = true`. A failed recheck ping increments the penalty. This ensures the router's `isKeyHealthy()` immediately reflects the result.

## 4. Non-Functional Requirements

### NFR-1: Performance
- Scheduling a recheck is O(1) — a `setTimeout` stored in a Map keyed by key ID.
- Recheck pings are individual HTTP calls, not bulk operations — one per key per timer fire.
- Total concurrent rechecks bounded by the number of exhausted keys, which is naturally limited by the number of enabled keys in the system.

### NFR-2: Backward Compatibility
- When `heartbeat_enabled = false`, no recheck timers are created — behavior identical to today.
- Existing `heartbeat.ping` events and regular cycle logic are unchanged.
- The `markKeyUnhealthy()` function currently does not schedule any recheck — this is a pure addition.
- `heartbeat_exhausted_recheck_sec` defaults to 90s, matching the existing `transient_cooldown_sec` default — operators who already tuned 429 cooldowns have a natural analog.

### NFR-3: Correctness
- A recheck timer MUST be canceled when the key recovers (to avoid a stale ping after the key is already healthy).
- A recheck timer MUST be canceled on server shutdown (`stopHeartbeat()` handles this).
- Recheck timers MUST NOT fire during a regular heartbeat cycle for the same key (the regular cycle updates `lastPingAt`, and FR-4's recency check prevents double-pinging).
- The recheck counter (attempt number) must reset when the key recovers — a future exhaustion starts fresh rechecks from attempt 1.

### NFR-4: Timer Memory Bound
- Each pending recheck stores a `NodeJS.Timeout` reference. On graceful shutdown, all timers are cleared.
- The `recheckTimers` Map is pruned when timers fire or keys recover — it does not grow unboundedly.
- Maximum theoretical size = number of enabled keys (all simultaneously exhausted). In practice, far fewer.

### NFR-5: Token Cost Bound
- Worst case: N exhausted keys × max_rechecks pings each × ~10 tokens per ping.
- With 10 keys and max_rechecks=3: 300 tokens per exhaustion wave.
- At 90-second recheck intervals, recovery costs at most ~30 tokens/key before the key is either restored or the recheck budget is exhausted.

## 5. Out of Scope

- **Preemptive recheck of cooldown-only keys** — The existing `sweepStaleExhaustion()` handles cooldown expiry. This spec targets heartbeat-unhealthy keys specifically.
- **Adaptive recheck intervals** (exponential backoff on repeated failures) — The max_rechecks cap is sufficient for now. Adaptive intervals add complexity for marginal benefit.
- **Cross-key recheck coordination** (batching rechecks for the same provider) — Individual timers are simpler and stagger naturally. Batch coordination is a future optimization.
- **Persisting recheck state across restarts** — Recheck timers are fire-and-forget. After a restart, the regular heartbeat cycle's startup prewarm covers all keys. Lost in-flight rechecks are harmless.

## 6. Relationship to Existing Features

| Feature | Relationship |
|---|---|
| **Provider Health Heartbeat** | Parent feature. Recheck depends on heartbeat being enabled and reuses `pingKey()`. Covers all keys periodically; recheck targets specific exhausted keys on an accelerated timeline. |
| **Phantom Exhaustion Fix** | Prerequisite. The `sweepStaleExhaustion()` and `'error'`-status fixes ensure keys are reachable and the exhaustion map is accurate. Without these, rechecks could ping keys that are structurally invisible to routing. |
| **Transient 429 Cooldown** | Alternative mechanism when heartbeat is disabled. Cooldowns bench for a fixed duration; rechecks actively probe for recovery. When heartbeat is enabled, cooldowns are disabled (`disableWhen: 'heartbeat_enabled'`). |
| **`pokeKey()` API** | On-demand single-key ping. Recheck is the automatic counterpart — it calls the same `pingKey()` logic but on a timer. |
| **`markKeyUnhealthy()`** | The trigger. Currently evicts a key from routing with no recovery path beyond the next heartbeat cycle. Recheck adds a directed recovery path. |
