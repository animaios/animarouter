# Plan: Temporary Model Boosters

## Concept

Add a **booster** mechanism that lets operators temporarily boost specific models to the top of Thompson sampling routing. Boosted models get an overwhelming score advantage (essentially bypassing all other weights), while still respecting rate limits, key availability, cooldowns, and all other hard constraints.

**Use case:** Testing a new model, canarying a provider, or temporarily preferring one model during an incident — without permanently reordering the fallback chain or changing strategy presets.

---

## Design

### Storage

Boosters live in the `settings` table as a JSON blob under key `model_boosters`:

```json
{
  "123": { "multiplier": 1000, "expiresAt": 1750000000000 },
  "456": { "multiplier": 1000, "expiresAt": null }
}
```

- Key is `model_db_id` (string). Value has `multiplier` (number, how much to boost the score) and optional `expiresAt` (epoch ms, null = manual/explicit only).
- No schema migration needed — this reuses the existing `settings` table.

### Scoring integration

In `scoreChainEntry()` (router.ts), after the normal `combineScore()` call, check if the model has an active booster. If so, multiply the score by the booster multiplier:

```
effectiveScore = score * boosterMultiplier
```

This is elegant because:
- A 1000× multiplier makes a boosted model's sampled score (max ~1.0) become ~1000 — always sorting above any non-boosted model (max score ~1.0 × rateLimit ≤ 1.0).
- Rate limiting still works: if the model hits 429s, `rateLimitFactor` drops its base score, and 1000 × 0.4 = 400 still beats a healthy 0.8 but once ALL keys are exhausted/rate-limited, it naturally falls below.
- Actually wait — even a rate-limited model with 1000× multiplier would have score ~400 which still beats everything. We need to ensure the booster does NOT bypass rate-limit signals that indicate the model IS exhausted. Let me think...

**Refined approach:** Apply the booster multiplier AFTER rate-limit factor, but cap it with a "soft discredit" if the model has a high penalty. Specifically: the booster is reduced by the rate-limit penalty as well (the rateLimit factor already applies to the base score before the booster). So:

```
base = convex_combine(weights)  // ∈ [0,1]
effective = base * rateLimit * boosterMultiplier
```

This means:
- When all keys are rate limited for a model → base approaches 0 as reliability drops → even 1000× 0 = 0. The model won't win.
- When a model has a mild 429 penalty → rateLimit = 0.7 → still 1000× base × 0.7 = ~700, still wins. This is fine — mild rate limiting shouldn't override a manual boost.
- When keys exist and are healthy → the booster dominates. ✓

This is the right behavior: the booster respects "this model truly cannot serve" (no keys, exhausted) but overrides "this model is slightly penalized" (mild 429s).

### Expiry

On each `getBoosters()` call, expired entries are pruned. This is cheap since the map is typically 0-5 entries.

### Priority mode

In 'priority' strategy, boosters work by temporarily moving the boosted model's effective priority to `0` (or negative), placing it before everything else. Simpler than injecting a multiplier into a non-scored ordering.

---

## Changes by file

### 1. `server/src/services/router.ts`

**New functions:**
- `getBoosters(): Map<number, { multiplier: number, expiresAt: number | null }>` — reads from settings, prunes expired, returns live map
- `setBooster(modelDbId: number, multiplier: number, durationMs: number | null): void` — adds/updates a booster, persists
- `removeBooster(modelDbId: number): void` — removes one entry
- `clearBoosters(): void` — removes all entries

**Modified functions:**
- `scoreChainEntry()` — after `combineScore()`, check if model has an active booster; if so, multiply the returned score
- `orderChain()` — in priority mode, boosted models get `effective_priority = -booster_multiplier` (sorting before everything)
- `getRoutingScores()` — include booster info in the returned score objects (so the dashboard can show it)

**New exported interface:**
```ts
export interface BoosterEntry {
  modelDbId: number;
  multiplier: number;
  expiresAt: number | null;
}
```

**Add to `RoutingScore` interface:**
```ts
boosterMultiplier?: number;  // undefined = no booster active
```

### 2. `server/src/routes/fallback.ts`

**New endpoints:**
- `GET /api/fallback/boosters` — list active boosters (with model details)
- `POST /api/fallback/boosters` — set a booster `{ modelDbId, multiplier?, durationMs? }` (defaults: multiplier=1000, durationMs=null)
- `DELETE /api/fallback/boosters/:modelDbId` — remove one booster
- `DELETE /api/fallback/boosters` — clear all

Also: include `boosterMultiplier` in the `GET /routing` response scores.

### 3. `shared/types.ts`

**New shared type:**
```ts
export interface ModelBooster {
  modelDbId: number;
  multiplier: number;
  expiresAt: number | null;  // epoch ms, null = no expiry
}
```

### 4. `server/src/__tests__/services/router-bandit.test.ts`

**New tests:**
- Booster makes a weak model dominate over a strong one
- Expired booster is pruned (model returns to normal ranking)
- Booster respects rate-limit exhaustion (all keys rate-limited → falls through)
- Multiple boosters (both boosted, highest multiplier wins)
- Remove booster works
- Priority mode booster works (boosted model goes to front)

### 5. `server/src/__tests__/services/scoring.test.ts`

No changes needed — the booster multiplier is applied at the router level, not inside scoring combinators.

---

## Default values

- `multiplier`: **1000** — large enough that a boosted model with any positive base score always wins over a non-boosted model. Not infinity, so pathological states (base ≈ 0 from extreme failures) still correctly deprioritize.
- `durationMs`: **null** (no auto-expiry) — operator explicitly sets a duration if they want auto-expiry. Common choices: 1 hour (3600000), 30 min (1800000).

## Key invariants

1. Boosters do NOT bypass key availability, cooldowns, context-window checks, or parallel-request gating in `routeRequest()`. They only affect the *ordering* of the chain.
2. A boosted model with zero available keys still falls through — the routing loop skips it.
3. Expired boosters are cleaned up lazily on read (no background timer needed).
4. The booster setting survives server restarts (persisted in SQLite `settings`).
