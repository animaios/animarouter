# Heartbeat Auto-Disable — Requirements

## 1. Problem Statement

When a provider model has keys that are consistently failing heartbeat pings, the current system handles it in two ways:

1. **Per-key health exclusion** (`keyHealthMap`): Keys with failed pings are marked unhealthy and excluded from routing. But the keys still exist — they're just temporarily benched.
2. **Model-level degradation** (`degradation.ts`): The model accumulates penalty from `recordFailure()`. The bandit scorer avoids it, but it's not *disabled*.

Neither mechanism **permanently disables the model** in the database. If every key for a model has failed heartbeat pings (e.g., the model is deprecated upstream, the key tier was downgraded, or the provider removed the model), the model sits in the fallback chain burning attempts on every routing pass:

- The router queries `healthyKeys`, finds none, and moves to the next model
- But the model still appears as "enabled" in the dashboard's Models tab
- An operator must manually notice and disable it

**Gap**: When a model's key pool is comprehensively unhealthy (≥50% of keys failing heartbeat), it's a strong signal that this model is broken for the operator's account/tier. The system should proactively disable it.

---

## 2. User Stories

### US-1: Auto-Disable Models with Unhealthy Keys
**As an operator**, when more than a configurable percentage of all keys for a model have failed their most recent heartbeat pings, I want the system to automatically disable that model (`models.enabled = 0`), so it stops appearing in the fallback chain and dashboard.

### US-2: Configurable Threshold
**As an operator**, I want to control the unhealthy-key percentage threshold (1–100%) via the Settings UI, with a sensible default (50%). A lower threshold is more aggressive (disables models faster); a higher one is more conservative.

### US-3: Dashboard Visibility
**As an operator**, I want disabled models to be clearly marked as "auto-disabled by heartbeat" in the Models tab (distinguishable from manual disable), so I know why it happened.

### US-4: Recovery Path
**As an operator**, if a model is auto-disabled but its keys later recover (heartbeat pings succeed), I want to be able to manually re-enable it. The system should NOT auto-enable — only the operator decides when the model is ready.

### US-5: Idempotent Checks
**As an operator**, I want the auto-disable check to be idempotent — running it on an already-disabled model is a no-op. No repeated DB writes or events for health states that have already been addressed.

---

## 3. Functional Requirements

### FR-1: Auto-Disable Trigger

After each heartbeat cycle completes, the system shall evaluate every model that was pinged in the cycle. For each model:

1. Count all enabled keys `K_total` for the model's platform (matching `api_keys.enabled = 1`)
2. Count keys that have `healthy: false` in `keyHealthMap` — `K_unhealthy`
3. If `K_total > 0` and `(K_unhealthy / K_total) * 100 >= auto_disable_threshold_pct`, set `models.enabled = 0`

```typescript
function evaluateAutoDisable(modelDbId: number, platform: string): void {
  const db = getDb();
  const allKeys = db.prepare(
    "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1"
  ).all(platform) as Array<{ id: number }>;

  const total = allKeys.length;
  if (total === 0) return; // No keys → no conclusion

  let unhealthy = 0;
  for (const k of allKeys) {
    const health = keyHealthMap.get(k.id);
    if (health && !health.healthy) unhealthy++;
    else if (!health && isHeartbeatEnabled()) unhealthy++; // Cold key with heartbeat = assumed unhealthy
  }

  const pct = (unhealthy / total) * 100;
  if (pct >= getAutoDisableThresholdPct()) {
    db.prepare("UPDATE models SET enabled = 0 WHERE id = ? AND enabled = 1")
      .run(modelDbId);
    // If the row was actually updated (was enabled), emit event
  }
}
```

### FR-2: Evaluation Timing

The auto-disable check runs **after** each heartbeat cycle completes, not as part of the routing path. This keeps the routing path pure and ensures the decision is based on fresh ping data.

**Integration point**: At the end of `runCycle()` in `heartbeat.ts`, after all pings complete and before the `cycleInProgress` flag is cleared.

### FR-3: Configurable Threshold

| Setting | Env var | Default | Min | Max | Effect | Group |
|---|---|---|---|---|---|---|
| `heartbeat_auto_disable_pct` | `HEARTBEAT_AUTO_DISABLE_PCT` | `0` | `0` | `100` | `live` | Resilience |

Value represents the percentage of all keys for a model that must be unhealthy to trigger auto-disable. Set to `0` to disable the feature entirely. At `100`, all keys must be unhealthy. At `1`, a single unhealthy key triggers it (aggressive).

The setting is `live`-effect (not `restart`), so operators can adjust it without restarting the server.

### FR-4: Event Emission

Add a new event variant:

```typescript
| { type: 'heartbeat.auto_disable'; provider: string; model: string; modelDbId: number; totalKeys: number; unhealthyKeys: number; threshold: number; at: number }
```

Emitted exactly once per model when the auto-disable check transitions the model from `enabled = 1` to `enabled = 0`. Not emitted on re-checks of already-disabled models.

### FR-5: Dashboard Rendering

The dashboard's Models tab (`client/src/pages/ModelsPage.tsx` or equivalent) shall render auto-disabled models with:

- A distinct visual indicator (e.g., `🤖 auto` badge) next to the model name
- A tooltip or subtitle: `Auto-disabled by heartbeat: {X} of {Y} keys unhealthy`
- The disable action remains manual re-enable (toggle in the UI works as before)

The `heartbeat.auto_disable` event also appears in the live-event feed:

```typescript
case 'heartbeat.auto_disable':
  return { id: evt.id, ts, kind: 'warn',
    text: `🤖 Auto-disabled ${evt.provider}/${evt.model}: ${evt.unhealthyKeys}/${evt.totalKeys} keys unhealthy (threshold ${evt.threshold}%)` };
```

### FR-6: No-Auto-Enable

Auto-disable is one-way. The system must NEVER auto-enable a model. Once `models.enabled = 0`, only manual operator action (clicking the enable toggle in the dashboard) can restore it.

This is enforced by the DB update being a no-op on the re-check path: `UPDATE models SET enabled = 0 WHERE id = ? AND enabled = 1` — the `AND enabled = 1` clause means the update only fires once.

### FR-7: Integration with Existing Model Endpoints

The `GET /api/models` endpoint (`server/src/routes/models.ts`) already returns `enabled` and key counts. No changes needed for the model list. The auto-disable's `enabled = 0` is just a normal model state change.

The existing model enable/disable endpoints handle re-enable. No new API needed.

### FR-8: Startup Safety

On server restart:
- `keyHealthMap` is empty
- The startup prewarm cycle (`runCycle(true)`) re-pings all keys
- Auto-disable evaluation runs after the prewarm cycle completes
- Models with genuinely dead keys get disabled within seconds of startup

---

## 4. Non-Functional Requirements

### NFR-1: Backward Compatibility
- Feature is gated on `heartbeat_enabled` — when heartbeat is off, the check never runs
- No changes to routing, scoring, degradation, or cooldown logic
- No new tables or columns — `models.enabled` already exists

### NFR-2: Performance
- The auto-disable check runs once per heartbeat cycle (not per-request)
- O(N_keys) per platform per cycle — negligible for typical key counts (5-50)
- DB write only happens when a model transitions from enabled → disabled

### NFR-3: Correctness
- Cold keys (never pinged) are counted as unhealthy when heartbeat is enabled — consistent with `isKeyHealthy()` returning `false` for unknown keys
- The `AND enabled = 1` clause on the UPDATE prevents repeated writes for already-disabled models
- Only keys that EXIST in `api_keys.enabled = 1` are counted — deleted or disabled keys don't inflate the denominator

### NFR-4: Observability
- `heartbeat.auto_disable` event visible in the live-event feed
- The event includes `totalKeys`, `unhealthyKeys`, and `threshold` for full transparency
- The Models tab shows `enabled: false` with auto-disable reason

---

## 5. Out of Scope

- **Auto-enable** — Deliberately excluded. Only manual operator action restores a disabled model.
- **Per-provider threshold** — One global threshold for all providers. Per-provider tuning can be added later if needed.
- **Re-enable on heartbeat success** — If all keys for a model recover, the operator must manually re-enable. This is a conscious design choice to avoid oscillation.
- **Scheduled or time-based disable** — Only heartbeat-triggered. No time-based auto-disable.
- **Alerting** — No external notifications. The live-event stream and dashboard are sufficient.
