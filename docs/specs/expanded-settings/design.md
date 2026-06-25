# Expanded Settings — Design Document

## 1. Architecture Overview

The existing feature-settings system (`server/src/services/feature-settings.ts`) already provides a clean extension point: the `REGISTRY` array, `resolveSetting()`, `getAllFeatureSettings()`, and `saveFeatureSettings()`. The client (`SettingsPage.tsx`, `settings-section.tsx`, `setting-row.tsx`) already renders dynamically from the registry via the API.

The main changes are:

1. **Schema extension** — add `string` type with `options` enum support
2. **Registry expansion** — 16 new settings across 4 new groups
3. **Constant migration** — replace hardcoded values / env-var reads with `getFeatureSetting()` calls in 5 server modules
4. **Client addition** — `<Select>` dropdown for string-enum settings in `setting-row.tsx`
5. **Fallback page cleanup** — remove duplicate retry-limit UI

No new API endpoints, no new DB tables, no new pages.

```
┌─────────────────┐     GET/PUT      ┌──────────────────────┐     read      ┌─────────┐
│  SettingsPage    │ ──────────────▶  │  /api/settings/      │ ──────────▶  │  DB     │
│  (React)        │    /features     │  features            │              │ settings│
└─────────────────┘                   └──────────────────────┘              └─────────┘
                                              │
                                    resolveSetting()
                                    (DB → env → default)
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
           ratelimit.ts           degradation.ts          context-handoff.ts
          (cooldowns,             (half-lives,             (TTLs, handoff
           retry limit)            penalty, recovery)        mode)
```

---

## 2. Server Changes

### 2.1 Schema: `FeatureSettingDef` Type Extension

**File:** `server/src/services/feature-settings.ts`

```typescript
export interface FeatureSettingDef {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'number' | 'string';   // ← add 'string'
  default: boolean | number | string;       // ← widen
  min?: number;
  max?: number;
  options?: string[];         // ← NEW: required when type='string'
  envVar?: string;
  effect: 'live' | 'restart';
  group: string;
  parentToggle?: string;
}
```

### 2.2 Registry: New Entries

Add the following entries to `REGISTRY` in `server/src/services/feature-settings.ts`:

```typescript
// ── Sessions (additions) ──
{
  key: 'context_handoff_mode',
  label: 'Context Handoff',
  description:
    'Inject a conversation summary when the router switches the model mid-session. "on_model_switch" enables handoff on model change; "off" disables it.',
  type: 'string',
  default: 'off',
  options: ['off', 'on_model_switch'],
  envVar: 'ANIMAROUTER_CONTEXT_HANDOFF',
  effect: 'live',
  group: 'Sessions',
},
{
  key: 'session_ttl_min',
  label: 'Session Memory TTL (min)',
  description:
    'How long the proxy remembers session context (messages, last model) before discarding it. Longer TTLs use more memory but survive longer gaps between requests.',
  type: 'number',
  default: 180,
  min: 30,
  max: 1440,
  effect: 'restart',
  group: 'Sessions',
},
{
  key: 'sticky_session_ttl_min',
  label: 'Sticky Session TTL (min)',
  description:
    'How long the router pins a session to the same model. After this period the router is free to choose a different model on the next request.',
  type: 'number',
  default: 30,
  min: 5,
  max: 1440,
  effect: 'restart',
  group: 'Sessions',
  parentToggle: 'sticky_session_enabled',
},

// ── Retry & Failover (new group) ──
{
  key: 'global_retry_limit',
  label: 'Max Retry Attempts',
  description:
    'Maximum number of models the router tries before giving up. Higher values increase resilience at the cost of latency for failing requests.',
  type: 'number',
  default: 5,
  min: 1,
  max: 50,
  effect: 'live',
  group: 'Retry & Failover',
},
{
  key: 'transient_cooldown_sec',
  label: 'Transient 429 Cooldown (sec)',
  description:
    'How long a model+key is benched after a per-minute 429 (rate limit). Short values recover faster; long values avoid re-hitting a tight RPM quota.',
  type: 'number',
  default: 90,
  min: 5,
  max: 300,
  effect: 'live',
  group: 'Retry & Failover',
},
{
  key: 'payment_cooldown_hours',
  label: 'Payment-Required Cooldown (hours)',
  description:
    'How long a model+key is benched after a 402 (out of credits). Payment issues rarely self-resolve within a day; use a high value to avoid hammering dead keys.',
  type: 'number',
  default: 24,
  min: 1,
  max: 168,
  effect: 'live',
  group: 'Retry & Failover',
},
{
  key: 'forbidden_cooldown_hours',
  label: 'Model-Forbidden Cooldown (hours)',
  description:
    'How long a model+key is benched after a 403 (key tier cannot access this model). This rarely changes, so a long bench avoids wasting retries.',
  type: 'number',
  default: 24,
  min: 1,
  max: 168,
  effect: 'live',
  group: 'Retry & Failover',
},

// ── Degradation (new group) ──
{
  key: 'degrade_minor_half_life_min',
  label: 'Minor Half-Life (min)',
  description:
    'Decay half-life for minor errors (timeouts, network issues). Shorter half-lives make the engine forget errors faster; longer half-lives make it more cautious.',
  type: 'number',
  default: 2,
  min: 0.5,
  max: 30,
  envVar: 'DEGRADE_MINOR_HALF_LIFE_MIN',
  effect: 'restart',
  group: 'Degradation',
},
{
  key: 'degrade_major_half_life_min',
  label: 'Major Half-Life (min)',
  description:
    'Decay half-life for major errors (server errors). A 15-min half-life means a major error counts for half its weight after 15 minutes of no further failures.',
  type: 'number',
  default: 15,
  min: 1,
  max: 120,
  envVar: 'DEGRADE_MAJOR_HALF_LIFE_MIN',
  effect: 'restart',
  group: 'Degradation',
},
{
  key: 'degrade_critical_half_life_min',
  label: 'Critical Half-Life (min)',
  description:
    'Decay half-life for critical errors (auth failures, invalid keys). Critical penalties are long-lived by design to keep the router away from fundamentally broken keys.',
  type: 'number',
  default: 60,
  min: 5,
  max: 480,
  envVar: 'DEGRADE_CRITICAL_HALF_LIFE_MIN',
  effect: 'restart',
  group: 'Degradation',
},
{
  key: 'degrade_max_penalty',
  label: 'Max Penalty Score',
  description:
    'Upper bound for the accumulated penalty. A model at max penalty is effectively dead to the router (score near zero).',
  type: 'number',
  default: 100,
  min: 10,
  max: 500,
  envVar: 'DEGRADE_MAX_PENALTY',
  effect: 'restart',
  group: 'Degradation',
},
{
  key: 'degrade_success_recovery',
  label: 'Success Recovery Rate',
  description:
    'Fraction of penalty removed per successful request. 0.3 = 30% penalty reduction on each success. Higher values forgive faster.',
  type: 'number',
  default: 0.3,
  min: 0.01,
  max: 1.0,
  envVar: 'DEGRADE_SUCCESS_RECOVERY',
  effect: 'restart',
  group: 'Degradation',
},
{
  key: 'degrade_critical_threshold',
  label: 'Critical Consecutive Threshold',
  description:
    'Number of consecutive failures that trigger the critical tier. Once hit, the half-life ratchets to the critical value, making recovery much slower.',
  type: 'number',
  default: 3,
  min: 2,
  max: 20,
  envVar: 'DEGRADE_CRITICAL_THRESHOLD',
  effect: 'restart',
  group: 'Degradation',
},

// ── Analytics & Data (new group) ──
{
  key: 'analytics_retention_days',
  label: 'Request Log Retention (days)',
  description:
    'How many days of request analytics to keep. Older rows are pruned automatically. Reduce on storage-constrained deployments; increase for long-term trend analysis.',
  type: 'number',
  default: 90,
  min: 7,
  max: 365,
  envVar: 'REQUEST_ANALYTICS_RETENTION_DAYS',
  effect: 'live',
  group: 'Analytics & Data',
},
{
  key: 'analytics_max_rows',
  label: 'Max Request Rows',
  description:
    'Hard cap on the number of rows in the request log. When exceeded, the oldest rows are pruned regardless of retention days. Set to 0 for unlimited (not recommended).',
  type: 'number',
  default: 100000,
  min: 0,
  max: 1000000,
  envVar: 'REQUEST_ANALYTICS_MAX_ROWS',
  effect: 'live',
  group: 'Analytics & Data',
},

// ── Scoring (new group) ──
{
  key: 'scoring_window_days',
  label: 'Stats Look-back Window (days)',
  description:
    'How far back the scoring engine looks for request history. A 7-day window balances stability (enough data) with responsiveness (old failures fade out).',
  type: 'number',
  default: 7,
  min: 1,
  max: 30,
  effect: 'restart',
  group: 'Scoring',
},
{
  key: 'scoring_decay_half_life_days',
  label: 'Stats Decay Half-Life (days)',
  description:
    'Decay rate for the scoring engine. A 2-day half-life means a request from 2 days ago counts for half as much as one from today.',
  type: 'number',
  default: 2,
  min: 0.5,
  max: 14,
  effect: 'restart',
  group: 'Scoring',
},
{
  key: 'scoring_cache_ttl_sec',
  label: 'Score Cache TTL (sec)',
  description:
    'How long the scoring engine caches its stats before re-querying. Lower values make the dashboard and routing more responsive; higher values reduce DB load.',
  type: 'number',
  default: 60,
  min: 5,
  max: 600,
  effect: 'restart',
  group: 'Scoring',
},
```

### 2.3 Resolution Logic Changes

**File:** `server/src/services/feature-settings.ts`

`resolveSetting()` needs to handle the new `string` type:

```typescript
function resolveSetting(def: FeatureSettingDef): boolean | number | string {
  const dbValue = getSetting(def.key);
  if (dbValue !== undefined) {
    if (def.type === 'boolean') return dbValue === 'true';
    if (def.type === 'number') return parseFloat(dbValue);
    return dbValue;  // string — return as-is
  }

  if (def.envVar && process.env[def.envVar] !== undefined) {
    const raw = process.env[def.envVar]!;
    if (def.type === 'boolean') return raw === 'true';
    if (def.type === 'number') return parseFloat(raw);
    return raw;  // string
  }

  return def.default;
}
```

### 2.4 Validation Changes

**File:** `server/src/services/feature-settings.ts`

Add string validation to `saveFeatureSettings()`:

```typescript
if (def.type === 'string') {
  if (typeof value !== 'string') {
    errors.push(`${key}: expected string, got ${typeof value}`);
  } else if (def.options && !def.options.includes(value)) {
    errors.push(`${key}: must be one of ${def.options.join(', ')}`);
  }
}
```

### 2.5 Degradation Module Migration

**File:** `server/src/services/degradation.ts`

Replace the `envFloat` / `envMinutesToMs` / `envInt` calls in `initDegradation()` with `getFeatureSetting()`:

```typescript
import { getFeatureSetting } from './feature-settings.js';

export function initDegradation(configOverrides?: Partial<DegradationConfig>): void {
  const minorHalfLifeMs = (getFeatureSetting('degrade_minor_half_life_min') as number) * 60 * 1000;
  const majorHalfLifeMs = (getFeatureSetting('degrade_major_half_life_min') as number) * 60 * 1000;
  const criticalHalfLifeMs = (getFeatureSetting('degrade_critical_half_life_min') as number) * 60 * 1000;

  const base: DegradationConfig = {
    minor: {
      weight: getFeatureSetting('degrade_minor_weight') as number,  // keep env fallback
      halfLifeMs: minorHalfLifeMs,
    },
    major: {
      weight: getFeatureSetting('degrade_major_weight') as number,
      halfLifeMs: majorHalfLifeMs,
    },
    critical: {
      weight: getFeatureSetting('degrade_critical_weight') as number,
      halfLifeMs: criticalHalfLifeMs,
      consecutiveThreshold: getFeatureSetting('degrade_critical_threshold') as number,
    },
    compoundFactor: getFeatureSetting('degrade_compound_factor') as number,
    successRecovery: getFeatureSetting('degrade_success_recovery') as number,
    dampStrength: getFeatureSetting('degrade_damp_strength') as number,
    maxPenalty: getFeatureSetting('degrade_max_penalty') as number,
    boostMin: getFeatureSetting('degrade_boost_min') as number,
    boostMax: getFeatureSetting('degrade_boost_max') as number,
  };
  // ... rest unchanged
}
```

> **Note:** The degradation weight/compound/damp/boost env vars (`DEGRADE_MINOR_WEIGHT`, etc.) are NOT added to the Settings UI in this spec — they're too niche. They keep their `envFloat()` fallback via `getFeatureSetting()` which falls back to the env var via `resolveSetting()`. Only the 6 most operator-visible settings get UI entries.

### 2.6 Rate-Limit Module Migration

**File:** `server/src/services/ratelimit.ts`

Replace the three hardcoded cooldown constants with dynamic reads:

```typescript
import { getFeatureSetting } from './feature-settings.js';

// Remove: const TRANSIENT_COOLDOWN_MS = 90 * 1000;
// Remove: export const PAYMENT_REQUIRED_COOLDOWN_MS = DAY;
// Remove: export const MODEL_FORBIDDEN_COOLDOWN_MS = DAY;

function getTransientCooldownMs(): number {
  return (getFeatureSetting('transient_cooldown_sec') as number) * 1000;
}

export function getPaymentRequiredCooldownMs(): number {
  return (getFeatureSetting('payment_cooldown_hours') as number) * 3600 * 1000;
}

export function getModelForbiddenCooldownMs(): number {
  return (getFeatureSetting('forbidden_cooldown_hours') as number) * 3600 * 1000;
}
```

Update `computeRetryCooldownMs` and `getCooldownDurationForLimit` to call the new functions instead of reading the constants.

### 2.7 Context-Handoff Module Migration

**File:** `server/src/services/context-handoff.ts`

```typescript
import { getFeatureSetting } from './feature-settings.js';

// Replace: export function getContextHandoffMode(): ContextHandoffMode {
//   const raw = process.env.ANIMAROUTER_CONTEXT_HANDOFF?.trim().toLowerCase();
//   return raw === 'on_model_switch' ? 'on_model_switch' : 'off';
// }

export function getContextHandoffMode(): ContextHandoffMode {
  const mode = getFeatureSetting('context_handoff_mode') as string;
  return mode === 'on_model_switch' ? 'on_model_switch' : 'off';
}
```

For `SESSION_TTL_MS` — replace the hardcoded `3 * 60 * 60 * 1000` with a function that reads the setting:

```typescript
function getSessionTtlMs(): number {
  return (getFeatureSetting('session_ttl_min') as number) * 60 * 1000;
}
```

Then use `getSessionTtlMs()` wherever `SESSION_TTL_MS` was referenced. Since this is a `restart` effect, the value is read once at server startup and the setting change takes effect after restart.

### 2.8 Router Module Migration

**File:** `server/src/services/router.ts`

Replace the hardcoded scoring constants:

```typescript
import { getFeatureSetting } from './feature-settings.js';

// Instead of: const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Instead of: const HALF_LIFE_DAYS = 2;
// Instead of: const CACHE_TTL_MS = 60 * 1000;

function getScoringWindowMs(): number {
  return (getFeatureSetting('scoring_window_days') as number) * 24 * 60 * 60 * 1000;
}

function getScoringHalfLifeDays(): number {
  return getFeatureSetting('scoring_decay_half_life_days') as number;
}

function getScoringCacheTtlMs(): number {
  return (getFeatureSetting('scoring_cache_ttl_sec') as number) * 1000;
}
```

Then use these functions in `refreshStatsCache()` and wherever the constants were referenced. Since these are all `restart` effect, they're read once and the cache uses them until restart.

### 2.9 Retention Module Migration

**File:** `server/src/services/request-retention.ts`

Replace `getRequestAnalyticsRetentionConfig()`:

```typescript
import { getFeatureSetting } from './feature-settings.js';

export function getRequestAnalyticsRetentionConfig(): RequestAnalyticsRetentionConfig {
  return {
    retentionDays: getFeatureSetting('analytics_retention_days') as number,
    maxRows: getFeatureSetting('analytics_max_rows') as number,
  };
}
```

The existing `readNonNegativeInt()` function and its env var reads can be removed.

### 2.10 Proxy Module — Sticky TTL Migration

**File:** `server/src/routes/proxy.ts`

Replace the hardcoded `STICKY_TTL_MS = 30 * 60 * 1000`:

```typescript
import { getFeatureSetting } from '../services/feature-settings.js';

// Remove: const STICKY_TTL_MS = 30 * 60 * 1000;

function getStickyTtlMs(): number {
  return (getFeatureSetting('sticky_session_ttl_min') as number) * 60 * 1000;
}
```

### 2.11 Global Retry Limit Migration

**File:** `server/src/services/router.ts`

The existing `global_retry_limit` is stored as a plain DB setting via `getSetting('global_retry_limit')`. Migrate to `getFeatureSetting('global_retry_limit')` which provides the same DB → env → default resolution chain. The existing DB key becomes the first resolution tier automatically.

We can optionally keep the `setGlobalRetryLimit()` function that writes directly to the DB for backward compatibility, or route it through `saveFeatureSettings()`. For this spec, the simpler path is to keep `setGlobalRetryLimit()` writing the DB setting directly — `getFeatureSetting()` will read it back because it checks the DB first.

---

## 3. Shared Types Update

**File:** `shared/types.ts`

```typescript
export interface FeatureSetting {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'number' | 'string';   // ← widen
  value: boolean | number | string;        // ← widen
  default: boolean | number | string;       // ← widen
  min?: number;
  max?: number;
  options?: string[];         // ← NEW
  effect: 'live' | 'restart';
  group: string;
  parentToggle?: string;
}
```

---

## 4. Client Changes

### 4.1 `client/src/lib/api.ts` — Type Update

Update the `FeatureSetting` interface and `FeatureSettingsResponse` to match `shared/types.ts`.

### 4.2 `client/src/components/setting-row.tsx` — String Enum Dropdown

Add a new branch for `type === 'string'`:

```tsx
{setting.type === 'string' && setting.options && (
  <Select
    value={String(localValues[setting.key] ?? setting.value)}
    onValueChange={(val) => onChange(setting.key, val)}
  >
    <SelectTrigger className="w-[200px]">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {setting.options.map((opt) => (
        <SelectItem key={opt} value={opt}>
          {opt.replace(/_/g, ' ')}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
)}
```

The `onChange` handler signature widens to accept `boolean | number | string`.

### 4.3 `client/src/pages/SettingsPage.tsx` — Local Value Type

```typescript
const [localValues, setLocalValues] = useState<Record<string, boolean | number | string>>({});
```

The `changedKeys` diff logic already compares via `!==` which works for strings.

### 4.4 Fallback Page Cleanup

**File:** `client/src/pages/FallbackPage.tsx` (or equivalent)

Remove the retry-limit input from the Fallback page. The setting now lives exclusively in the Settings page.

**File:** `server/src/routes/fallback.ts`

Remove the `PUT /api/fallback/retry-limit` endpoint (or keep it as a redirect that delegates to `saveFeatureSettings`). Check whether any other code references it via `find_references`.

---

## 5. Integration Points

### 5.1 Call-Site Audit

Every file that currently reads one of the migrated constants MUST be updated:

| File | Symbol | Old pattern | New pattern |
|---|---|---|---|
| `ratelimit.ts` | `TRANSIENT_COOLDOWN_MS` | const reference | `getTransientCooldownMs()` |
| `ratelimit.ts` | `PAYMENT_REQUIRED_COOLDOWN_MS` | const reference | `getPaymentRequiredCooldownMs()` |
| `ratelimit.ts` | `MODEL_FORBIDDEN_COOLDOWN_MS` | const reference | `getModelForbiddenCooldownMs()` |
| `degradation.ts` | `envFloat('DEGRADE_...')` | env read | `getFeatureSetting('degrade_...')` |
| `degradation.ts` | `envMinutesToMs('DEGRADE_...')` | env read | `getFeatureSetting('degrade_...')` × 60000 |
| `degradation.ts` | `envInt('DEGRADE_...')` | env read | `getFeatureSetting('degrade_...')` |
| `context-handoff.ts` | `process.env.ANIMAROUTER_CONTEXT_HANDOFF` | env read | `getFeatureSetting('context_handoff_mode')` |
| `context-handoff.ts` | `SESSION_TTL_MS` | const | `getSessionTtlMs()` |
| `proxy.ts` | `STICKY_TTL_MS` | const | `getStickyTtlMs()` |
| `router.ts` | `WINDOW_MS` | const | `getScoringWindowMs()` |
| `router.ts` | `HALF_LIFE_DAYS` | const | `getScoringHalfLifeDays()` |
| `router.ts` | `CACHE_TTL_MS` | const | `getScoringCacheTtlMs()` |
| `request-retention.ts` | `readNonNegativeInt(...)` | env read | `getFeatureSetting('analytics_...')` |

### 5.2 Files NOT Changed

- `proxy.ts` (unrelated to cooldowns/ttl) — only the sticky TTL constant
- `providers/base.ts` — `parseRetryAfterMs` is purely a utility, no settings coupling
- DB migrations — no new columns needed; settings table is already key-value

---

## 6. Edge Cases

### 6.1 `live` Effect for Cooldowns

Cooldown settings are `live` because `computeRetryCooldownMs` is called per-request — changing the DB value is visible on the next 429. But if a key is *currently* on cooldown with the old duration, that cooldown's expiry isn't retroactively changed. The new duration only applies to the next cooldown set after the setting save. This is expected and safe.

### 6.2 `restart` Effect for Degradation

Degradation config is read once in `initDegradation()` and frozen. Changing the DB value only takes effect after restart (the `captureRunningValues()` / `hasPendingRestart()` pattern detects this). This must be tested: save a degradation setting, observe the restart-required badge, restart, verify the new values are active.

### 6.3 Sticky Session TTL

`STICKY_TTL_MS` is a `restart` setting because the sticky-session map doesn't currently support dynamic TTL — entries are created with a fixed expiry. After restart, new entries use the new TTL; existing entries expire per their original TTL. Evaluate whether a `live` flag could be supported in a follow-up (it would require checking TTL on access rather than at creation time).

### 6.4 Analytics Max Rows = 0

When `analytics_max_rows` is set to 0, the retention pruner should skip the row-count-based pruning. This is already handled by the existing `if (maxRows > 0)` guard in `pruneRequestAnalytics()`.

### 6.5 String Enum Default Change

If a new `options` value is added to `context_handoff_mode` in a future release (e.g. `"on_model_switch_and_threshold"`), the existing DB value will still be valid — `resolveSetting()` returns it as-is. The new option just becomes available in the dropdown.

### 6.6 `global_retry_limit` Dual-Key Compatibility

The existing code stores the retry limit under the DB key `global_retry_limit` (plain key written by `setGlobalRetryLimit()`). `getFeatureSetting()` also reads from the DB via `getSetting('global_retry_limit')`. This means the existing DB row is automatically picked up — no data migration needed. The only change is the UI location moves from Fallback page to Settings page.

---

## 7. Testing Strategy

### 7.1 Server Unit Tests

**File:** `server/src/__tests__/services/feature-settings.test.ts`

- Test string enum resolution (DB → env → default)
- Test string enum validation (reject value not in `options`)
- Test all new number settings validate against min/max
- Test `parentToggle` interaction for new settings

### 7.2 Module Migration Tests

Each migrated module needs a test that proves it reads from `getFeatureSetting()`:

- **degradation.test.ts**: Set a feature-setting DB value for half-life, call `initDegradation()`, verify the config reads the new value
- **ratelimit.test.ts**: Set feature-setting DB value for transient cooldown, call `computeRetryCooldownMs()`, verify the returned duration matches
- **context-handoff.test.ts**: Set `context_handoff_mode` in DB, verify `getContextHandoffMode()` returns it; set `session_ttl_min`, verify TTL
- **request-retention.test.ts**: Set retention days/rows in DB, verify `getRequestAnalyticsRetentionConfig()` reads them

### 7.3 Integration Test

- Save a setting via `PUT /api/settings/features`
- Verify `GET /api/settings/features` reflects the saved value
- For `restart`-effect settings: verify `pendingRestart: true`
- For `live`-effect settings: verify the change is immediately visible in the dependent module's behavior

### 7.4 Client Manual Test

- Open Settings page → observe new groups
- Toggle `context_handoff_mode` dropdown → verify unsaved-changes bar appears
- Increase `analytics_max_rows` → save → verify toast
- Set a degradation half-life → verify restart-required banner appears
