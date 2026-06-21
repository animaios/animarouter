# Phantom Exhaustion Fix — Requirements

## 1. Problem Statement

Users with **valid, quota-rich API keys** see "Pinned model exhausted — all keys for the requested model are rate-limited or on cooldown." The only recovery is manually clicking "Check" on each key in the dashboard, which calls `checkKeyHealth` → `validateKey` → success → `status = 'healthy'`.

This affects **multiple providers**, not just one. Providers with slower endpoints (custom/OpenAI-compat like LongCat) or tier-gated model access are most susceptible.

## 2. Root Causes

Three interlocking bugs produce this symptom. Each is independently fixable; together they form the cascade.

### RC-1: `status = 'error'` creates a recovery dead zone (CRITICAL)

**Path to corruption:**

1. `health.ts` (`checkKeyHealth`) or the periodic `checkAllKeys` calls `provider.validateKey()`.
2. If the call throws a **transport error** (timeout, DNS, TLS — not auth failure), L58-60 sets `status = 'error'` in the DB.
3. The router's key query (router.ts L584) filters `WHERE status IN ('healthy', 'unknown')` — **`'error'` keys are invisible**.
4. The heartbeat's key query (heartbeat.ts L163) uses **the same filter** — so the heartbeat **cannot self-heal** an `'error'` key.
5. `checkAllKeys()` (every 5 minutes) queries `WHERE enabled = 1` (no status filter), so it **does** re-check error keys — but only when it runs. Between cycles, the key is invisible to routing.
6. **However**: if `checkAllKeys` itself hits a transport error on the same key, it **reaffirms** `status = 'error'` and the key stays invisible for another 5 minutes.

**Why "Check" fixes it:** The manual per-key check (`POST /health/check/:keyId`) runs the same `checkKeyHealth`, which also queries by ID (not by status), so it bypasses the visibility filter. A successful validation flips the key to `'healthy'`.

**Impact:** Any provider whose `/models` endpoint is slow (>10s was the original timeout) or flaky can lose all its keys from routing simultaneously. Users see "model exhausted" despite having quota.

### RC-2: Round-robin offset bypasses healthy-first key sorting (CRITICAL)

Flagged in PR #31 review by Gemini Code Assist, never addressed.

The router sorts keys healthy-first:

```typescript
const keyOrder = keys.sort((a, b) => {
  const aHealthy = isKeyHealthy(a.id) ? 0 : 1;
  const bHealthy = isKeyHealthy(b.id) ? 0 : 1;
  return aHealthy - bHealthy;
});
```

Then applies a flat round-robin offset into the sorted array:

```typescript
const key = keyOrder[(idx + attempt) % keyOrder.length];
```

If `idx = 2` and the sort produced `[H1, H2, U1, U2]`, the loop starts at `U1` — trying **both unhealthy keys before the healthy ones**. The "healthy-first" guarantee is broken whenever `idx > 0`.

**Impact:** When heartbeat marks keys unhealthy (especially from RC-3 model-specific 403s), the round-robin offsets traffic directly to the worst keys, causing rapid exhaustion.

### RC-3: Model-specific 403/404 errors poison key health globally (HIGH)

Flagged in PR #31 and #14 reviews, never addressed.

The heartbeat pings each key using an **arbitrary model** from the fallback chain (first model returned by an unordered SQL query). If that key's tier doesn't support that model, the upstream returns 403 or 404.

The heartbeat code (heartbeat.ts L242-249) then sets:

```typescript
keyHealthMap.set(keyRow.id, {
  penalty: newPenalty,      // incremented
  healthy: false,           // GLOBALLY unhealthy
  lastError: err.message,
});
```

This marks the key as globally unhealthy for **all models** on that platform. The router (RC-2) then deprioritizes this key across the board.

**Impact:** Providers with tier-gated models (LongCat, some OpenRouter tiers) can have perfectly healthy keys globally penalized because one model's tier check failed. Combined with RC-2, this pushes traffic toward already-healthy keys and creates load imbalance.

### RC-4: `exhaustionMap` entries never expire (MEDIUM)

`markExhausted(keyId)` adds an entry to the in-memory `exhaustionMap` that persists until:
- A successful request clears it via `clearExhausted(keyId, modelId)`
- Server restart (and only if the corresponding cooldown in DB has also expired)

If a key is exhausted and the router moves on to another model (never retrying the exhausted key+model), that entry stays in the map **forever** in the current process lifetime.

**Current impact is limited** — the router doesn't consult `isExhausted()` after PR #31 removed rate-limit pre-checks, and `areAllKeysExhausted()` is dead code (exported but never called). However:
- The map grows unboundedly
- Dashboard/API endpoints that consume exhaustion state show stale data
- Any future code that re-introduces exhaustion checks will hit this immediately

## 3. Evidence

| Signal | Points to |
|--------|-----------|
| "Check" button on key screen fixes it | RC-1: `status = 'error'` recovery dead zone |
| Affects multiple providers simultaneously | RC-1: shared health checker can hit transport issues for multiple providers in one cycle |
| Keys have "a lot of usage" (quota is fine) | RC-1/RC-2: not a quota problem, keys are structurally hidden from routing |
| PR #31 review flagged round-robin bug explicitly | RC-2: confirmed by code review, never fixed |
| PR #31/14 review flagged model-specific 403/404 | RC-3: confirmed by code review, never fixed |
