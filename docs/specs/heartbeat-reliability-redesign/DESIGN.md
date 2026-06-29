# Bandit Router — Heartbeat-Based Reliability Redesign

## Overview

- **Status**: Core router behavior implemented; analytics/dashboard exposure remains follow-up
- **Enabled when**: `heartbeat_enabled = true`
- **Fallback**: When heartbeat is disabled, use the historical Beta-posterior path

### Goal

Use a **real-time heartbeat health proportion** for router reliability while heartbeat is enabled:
- All keys healthy for a model → reliability = 100 (on a 0–100 scale)
- All keys sick for a model → reliability = 0
- Mixed health → linear interpolation between 0 and 100

This gives immediate feedback to routing when keys fail, rather than waiting for enough historical samples to shift the Beta posterior. When heartbeat is disabled, the router keeps the existing historical reliability behavior, including Thompson sampling during sampled bandit ordering.

### Historical vs. Heartbeat

| Signal | Historical fallback | Heartbeat-enabled behavior |
|--------|---------------------|----------------------|
| Reliability | `sampleBeta(alpha, beta)` during sampled ordering; `expectedReliability(successes, failures)` for deterministic score display | `heartbeatReliability(platform, modelId) / 100` for router scoring; helper returns `proportionHealthyKeys(platform, modelId) * 100` |
| Explore/Exploit | Thompson sampling from Beta when sampled | Deterministic health proportion |
| Window | Decay-weighted 30-day history | Instantaneous heartbeat state |
| Cold-start | Uniform prior (50%) | Cold keys = unhealthy (0%) |

## Design Details

### D1: Heartbeat Health Proportion

The function uses the existing `isKeyHealthy(k.id, modelId)` check which already handles:
- Cold key detection (returns `false` when heartbeat enabled and key never pinged)
- Per-model-per-key health state

```typescript
// In server/src/services/heartbeat.ts
export function proportionHealthyKeys(platform: string, modelId: string): number {
  const db = getDb();
  const keys = db
    .prepare(
      "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown', 'error')",
    )
    .all(platform) as KeyRow[];

  if (keys.length === 0) return 0;

  const healthyCount = keys.filter((k) => isKeyHealthy(k.id, modelId)).length;
  return healthyCount / keys.length;
}
```

The SQL already filters to enabled keys with acceptable statuses. The `isKeyHealthy` call then checks the in-memory heartbeat map for per-key-per-model health.

### D2: Reliability Score (0–100 Scale)

```typescript
/**
 * Heartbeat-based reliability score [0, 100].
 * - 100 = all keys healthy
 * - 0 = all keys sick
 * - Linear interpolation for mixed health
 */
export function heartbeatReliability(platform: string, modelId: string): number {
  const prop = proportionHealthyKeys(platform, modelId);
  return prop * 100; // [0, 1] → [0, 100]
}
```

### D3: Integration into Bandit Router

#### D3.1 Changes to `scoreChainEntry()`

```typescript
let reliability: number;
if (isHeartbeatEnabled()) {
  reliability = heartbeatReliability(entry.platform, entry.model_id) / 100; // normalize to [0,1]
} else if (sampled) {
  const { alpha, beta } = reliabilityPosterior(successes, failures);
  reliability = sampleBeta(alpha, beta);
} else {
  reliability = expectedReliability(successes, failures);
}
```

#### D3.2 Changes to `providerSubScore()`

```typescript
let reliability: number;
if (isHeartbeatEnabled()) {
  reliability = heartbeatReliability(provider.platform, provider.model_id) / 100;
} else if (sampled) {
  const { alpha, beta } = reliabilityPosterior(successes, failures);
  reliability = sampleBeta(alpha, beta);
} else {
  reliability = expectedReliability(successes, failures);
}
```

### D4: Fallback Behavior

When `heartbeat_enabled = false`:
- Use the original historical reliability path
- During sampled bandit ordering, continue to sample from `reliabilityPosterior(successes, failures)`
- During deterministic score display, use `expectedReliability(successes, failures)`
- No changes to existing behavior

### D5: Edge Cases

#### D5.1 No Keys for a Model
- `proportionHealthyKeys()` returns 0 → reliability = 0
- Model is effectively disabled (no keys to route to)

#### D5.2 Cold Keys (Never Pinged)
- `isKeyHealthy()` returns `false` for cold keys when heartbeat is enabled
- Treated as sick → pulls reliability toward 0
- Forces prewarming before routing (by design)

#### D5.3 Mixed Health Across Keys
- Linear interpolation: if 2 of 5 keys are healthy → reliability = 40
- Routing will still try the healthy keys first (existing healthy-key-first logic)

#### D5.4 Provider Grouping
- Each model in a group gets its own reliability score
- Group representative score still picks the best provider within the group
- No aggregation across models

### D6: Migration & Compatibility

#### D6.1 Feature Flag

```typescript
// router.ts
let reliability: number;
if (isHeartbeatEnabled()) {
  reliability = heartbeatReliability(platform, modelId) / 100;
} else if (sampled) {
  const { alpha, beta } = reliabilityPosterior(successes, failures);
  reliability = sampleBeta(alpha, beta);
} else {
  reliability = expectedReliability(successes, failures);
}
```

#### D6.2 Dashboard Display (Remaining Follow-Up)
- Show both reliability scores when heartbeat is enabled:
  - Heartbeat reliability (real-time)
  - Historical reliability (for comparison)

#### D6.3 Analytics Export (Remaining Follow-Up)
- Add `heartbeat_reliability` to `/api/analytics/by-model`
- Keep `reliability` column for backward compatibility

### D7: Testing Strategy

#### D7.1 Unit Tests
- Implemented: `proportionHealthyKeys()` with various healthy/sick ratios
- Implemented: `heartbeatReliability()` normalization to [0, 100]
- Implemented: fallback to historical when heartbeat disabled

#### D7.2 Integration Tests
- Implemented: route scoring with mixed healthy/sick keys
- Implemented: grouped provider ordering respects heartbeat reliability
- Existing healthy-key-first routing behavior remains covered separately

#### D7.3 End-to-End
- Disable heartbeat → old behavior
- Enable heartbeat → new behavior
- Toggle during runtime → seamless switch

### D8: Performance Considerations

- `proportionHealthyKeys()` does a single DB query per platform/model during scoring
- Remaining optimization: cache the result per scoring cycle to avoid repeated queries when the same platform/model is scored more than once
- Scoring cache TTL limits full score recomputation frequency

### D9: Future Enhancements

- Weight keys by historical performance (a key with 99% success counts more)
- Add latency/throughput into the health proportion (multi-axis health score)
- Predictive health based on advisor scores from `key_stats_temp.advisorScore`
