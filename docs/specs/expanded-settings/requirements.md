# Expanded Settings — Requirements

## 1. Problem Statement

The Settings page currently exposes **6 settings** across 2 groups (Resilience, Sessions). Meanwhile, many tuning knobs that operators regularly need are either:

- **Hardcoded constants** with no runtime adjustment (e.g., retry limits, cooldown durations, context-handoff parameters, analytics retention)
- **Env-var-only** configs requiring SSH + restart to change (e.g., degradation weights, half-lives, analytics retention)
- **DB-stored but UI-buried** settings that live on other pages (e.g., global retry limit is tucked inside the Fallback page, routing custom weights on the Models page)

This leaves operators either unable to tune the system or forced to learn env var names, SSH in, edit `.env`, and restart — exactly the pain the original global-settings-panel spec was meant to solve.

---

## 2. New Settings by Group

### Group: Resilience *(existing — no additions)*

| Key | Label | Type | Default | Min | Max | Effect | Env Var |
|---|---|---|---|---|---|---|---|
| `provider_fastfail_enabled` | Provider-Outage Fast-Fail | boolean | `true` | — | — | restart | `PROVIDER_FASTFAIL_ENABLED` |
| `provider_fastfail_threshold` | Fast-Fail Threshold | number | `2` | `0` | `10` | restart | `PROVIDER_FASTFAIL_THRESHOLD` |
| `heartbeat_enabled` | Provider Health Heartbeat | boolean | `false` | — | — | restart | `HEARTBEAT_ENABLED` |
| `heartbeat_interval_min` | Heartbeat Interval (min) | number | `10` | `1` | `60` | restart | `HEARTBEAT_INTERVAL_MIN` |
| `heartbeat_activity_window_min` | Activity Window (min) | number | `15` | `5` | `60` | restart | `HEARTBEAT_ACTIVITY_WINDOW_MIN` |

### Group: Sessions *(existing — 1 setting, 3 new)*

| Key | Label | Type | Default | Min | Max | Effect | Env Var | Notes |
|---|---|---|---|---|---|---|---|---|
| `sticky_session_enabled` | Sticky Sessions | boolean | `false` | — | — | live | `STICKY_SESSION_ENABLED` | *existing* |
| `context_handoff_mode` | Context Handoff | string (`off` \u00b7 `on_model_switch`) | `off` | \u2014 | \u2014 | live | `ANIMAROUTER_CONTEXT_HANDOFF` | New type \u2014 see \u00a73.1 |
| `session_ttl_min` | Session Memory TTL (min) | number | `180` | `30` | `1440` | restart | — | Controls `SESSION_TTL_MS` in context-handoff |
| `sticky_session_ttl_min` | Sticky Session TTL (min) | number | `30` | `5` | `1440` | restart | — | Controls `STICKY_TTL_MS` in proxy |

### Group: Retry & Failover *(new)*

| Key | Label | Type | Default | Min | Max | Effect | Env Var | Notes |
|---|---|---|---|---|---|---|---|---|
| `global_retry_limit` | Max Retry Attempts | number | `5` | `1` | `50` | live | — | Already in DB (`global_retry_limit` key); currently on Fallback page |
| `transient_cooldown_sec` | Transient 429 Cooldown (sec) | number | `90` | `5` | `300` | live | — | Controls `TRANSIENT_COOLDOWN_MS` in ratelimit |
| `payment_cooldown_hours` | Payment-Required Cooldown (hours) | number | `24` | `1` | `168` | live | — | Controls `PAYMENT_REQUIRED_COOLDOWN_MS` |
| `forbidden_cooldown_hours` | Model-Forbidden Cooldown (hours) | number | `24` | `1` | `168` | live | — | Controls `MODEL_FORBIDDEN_COOLDOWN_MS` |

### Group: Degradation *(new)*

Controls for the dynamic degradation engine (`server/src/services/degradation.ts`). All env-var-only today.

| Key | Label | Type | Default | Min | Max | Effect | Env Var | Notes |
|---|---|---|---|---|---|---|---|---|
| `degrade_minor_half_life_min` | Minor Half-Life (min) | number | `2` | `0.5` | `30` | restart | `DEGRADE_MINOR_HALF_LIFE_MIN` | How fast minor errors decay |
| `degrade_major_half_life_min` | Major Half-Life (min) | number | `15` | `1` | `120` | restart | `DEGRADE_MAJOR_HALF_LIFE_MIN` | How fast major errors decay |
| `degrade_critical_half_life_min` | Critical Half-Life (min) | number | `60` | `5` | `480` | restart | `DEGRADE_CRITICAL_HALF_LIFE_MIN` | How fast critical errors decay |
| `degrade_max_penalty` | Max Penalty Score | number | `100` | `10` | `500` | restart | `DEGRADE_MAX_PENALTY` | Upper bound for accumulated penalty |
| `degrade_success_recovery` | Success Recovery Rate | number | `0.3` | `0.01` | `1.0` | restart | `DEGRADE_SUCCESS_RECOVERY` | Fraction of penalty removed per success |
| `degrade_critical_threshold` | Critical Consecutive Threshold | number | `3` | `2` | `20` | restart | `DEGRADE_CRITICAL_THRESHOLD` | Consecutive failures that trigger critical tier |

### Group: Analytics & Data *(new)*

| Key | Label | Type | Default | Min | Max | Effect | Env Var | Notes |
|---|---|---|---|---|---|---|---|---|
| `analytics_retention_days` | Request Log Retention (days) | number | `90` | `7` | `365` | live | `REQUEST_ANALYTICS_RETENTION_DAYS` | How long request rows survive before pruning |
| `analytics_max_rows` | Max Request Rows | number | `100000` | `10000` | `1000000` | live | `REQUEST_ANALYTICS_MAX_ROWS` | Hard cap on request log table size |

### Group: Scoring *(new)*

Controls for the decay-weighted analytics that feed into the scoring/routing engine.

| Key | Label | Type | Default | Min | Max | Effect | Env Var | Notes |
|---|---|---|---|---|---|---|---|---|
| `scoring_window_days` | Stats Look-back Window (days) | number | `7` | `1` | `30` | restart | — | Controls `WINDOW_MS` in router stats cache |
| `scoring_decay_half_life_days` | Stats Decay Half-Life (days) | number | `2` | `0.5` | `14` | restart | — | Controls `HALF_LIFE_DAYS` in router |
| `scoring_cache_ttl_sec` | Score Cache TTL (sec) | number | `60` | `5` | `600` | restart | — | Controls `CACHE_TTL_MS` in router |

---

## 3. Schema Extension

### 3.1 New Type: `string` (enum)

The existing `FeatureSettingDef.type` is `'boolean' | 'number'`. To support `context_handoff_mode` (an enum choice), we add:

```typescript
interface FeatureSettingDef {
  // ... existing fields ...
  type: 'boolean' | 'number' | 'string';
  options?: string[];  // required when type='string' — allowed enum values
}
```

**Client implications:**
- When `type === 'string'` and `options` is present, render a `<Select>` dropdown (not a text input).
- Validation: server rejects any value not in the `options` array.
- The `value` union type becomes `boolean | number | string`.

**Scope:** This is the *only* new type for now. Multi-select, free-text strings, and JSON blobs are out of scope — they'd require a richer UI and validation model that isn't justified yet.

### 3.2 Unit Suffixes in Labels

Several new settings use non-obvious units (hours, seconds, days). To reduce mistakes:

- Labels include the unit: "Transient 429 Cooldown **(sec)**", "Payment-Required Cooldown **(hours)**"
- The DB always stores the base unit shown in the label (e.g., `90` means 90 seconds, not 90ms).
- The server converts to internal units (ms) at read time — same pattern as the existing `heartbeat_interval_min` (stored as minutes, internally converted to ms).

### 3.3 `parentToggle` Pairing

The existing `parentToggle` field (for disabling child number inputs when the parent toggle is off) extends naturally:

| Toggle | Children |
|---|---|
| `provider_fastfail_enabled` | `provider_fastfail_threshold` |
| `heartbeat_enabled` | `heartbeat_interval_min`, `heartbeat_activity_window_min` |
| `context_handoff_mode` (enabled ≠ `off`) | `session_ttl_min` |

For the string-type `context_handoff_mode`: the children are disabled when the value is `"off"`, enabled for any other value. The client checks `parentToggle` → if that setting's current value is falsy (`false` for boolean, `"off"` for string with options), disable the child.

---

## 4. User Stories

### US-1: Tune Retry Behavior Without SSH
**As an operator**, I want to adjust the max retry count and cooldown durations from the dashboard, so I can reduce latency-insensitive timeouts or increase persistence without SSH.

### US-2: Tune Degradation Sensitivity
**As an operator**, I want to adjust degradation half-lives and recovery rate from the dashboard, so I can make the engine more or less aggressive about avoiding flaky providers without editing env vars.

### US-3: Control Data Retention
**As an operator**, I want to set how long request logs are kept and how large the table can grow, so I can manage disk usage on resource-constrained deployments.

### US-4: Configure Session Behavior
**As an operator**, I want to enable context handoff and adjust session TTLs from the dashboard, so I can tune how the proxy handles mid-conversation model switches.

### US-5: Tune Scoring Freshness
**As an operator**, I want to adjust the scoring look-back window and cache TTL, so I can trade off between statistical stability (long window) and responsiveness to recent changes (short window).

### US-6: Discover Available Settings
**As an operator**, I want to browse all tunable parameters in one place with clear descriptions, so I don't have to read source code or env var names to know what's adjustable.

---

## 5. Functional Requirements

### FR-1: Extend Registry
Add all settings in §2 to the `REGISTRY` array in `server/src/services/feature-settings.ts` with the schema from §3.

### FR-2: Migrate Hardcoded Constants to Feature Settings
Each new setting replaces its current hardcoded value or env-var read:

| Constant / Pattern | File | Migration |
|---|---|---|
| `TRANSIENT_COOLDOWN_MS = 90 * 1000` | `server/src/services/ratelimit.ts` | Read `getFeatureSetting('transient_cooldown_sec')` × 1000 |
| `PAYMENT_REQUIRED_COOLDOWN_MS = DAY` | `server/src/services/ratelimit.ts` | Read `getFeatureSetting('payment_cooldown_hours')` × 3600000 |
| `MODEL_FORBIDDEN_COOLDOWN_MS = DAY` | `server/src/services/ratelimit.ts` | Read `getFeatureSetting('forbidden_cooldown_hours')` × 3600000 |
| `getGlobalRetryLimit()` from DB | `server/src/services/router.ts` | Migrate to `getFeatureSetting('global_retry_limit')`; keep existing DB key as fallback |
| `SESSION_TTL_MS` | `server/src/services/context-handoff.ts` | Read `getFeatureSetting('session_ttl_min')` × 60000 |
| `STICKY_TTL_MS` | `server/src/routes/proxy.ts` | Read `getFeatureSetting('sticky_session_ttl_min')` × 60000 |
| `getContextHandoffMode()` env read | `server/src/services/context-handoff.ts` | Read `getFeatureSetting('context_handoff_mode')` |
| `WINDOW_MS`, `HALF_LIFE_DAYS`, `CACHE_TTL_MS` | `server/src/services/router.ts` | Read from feature settings |
| Degradation env floats | `server/src/services/degradation.ts` | Replace `envFloat`/`envMinutesToMs` with `getFeatureSetting()` |
| Retention env reads | `server/src/services/request-retention.ts` | Replace `readNonNegativeInt` with `getFeatureSetting()` |

### FR-3: String Enum Type Support
- `FeatureSettingDef.type` gains `'string'` variant
- `FeatureSettingDef.options?: string[]` — required when `type === 'string'`
- `resolveSetting()` returns the string value as-is
- `saveFeatureSettings()` validates against `options` array
- Client renders a `<Select>` with `options` choices

### FR-4: Client Dropdown for String Enums
When a setting has `type: 'string'` and an `options` array, the `setting-row.tsx` component renders:
- A `<Select>` (shadcn `Select`) instead of a Switch or number input
- Each option as a choice
- The unsaved-changes / FloatingBar pattern works identically (compare local value to server value)

### FR-5: Remove Retry Limit from Fallback Page
Once `global_retry_limit` is in the Settings page, remove the duplicate UI from the Fallback page. The existing DB key continues to work as a fallback; `getFeatureSetting()` consults it.

### FR-6: Group Rendering
New groups (Retry & Failover, Degradation, Analytics & Data, Scoring) render as new `<SettingsSection>` blocks. The existing client code already dynamically groups by the `group` field — no code change needed. Just adding the settings to the server registry is sufficient.

### FR-7: Effect Semantics

Settings that are read once at startup and cached (degradation config, scoring cache TTL) are `effect: 'restart'`. Settings that are re-read on each request or checked lazily (retry limit, cooldowns, retention, session configs) are `effect: 'live'`.

> **Note on degradation:** Currently `initDegradation()` is called once at startup and the config is frozen. To make degradation settings `live` would require refactoring `getConfig()` to re-read on each call — a larger change. Marking them `restart` for now is correct and safe. A future spec may upgrade them to `live`.

### FR-8: Validation
Server-side validation in `saveFeatureSettings()` already handles `min`/`max` for numbers and type checks. New validations:

- For `type: 'string'`: `value` must be in `options` array → 400 if not
- Step size is not enforced (any number within min/max is valid)

---

## 6. Non-Functional Requirements

### NFR-1: Backward Compatibility
Every new setting has an `envVar` mapping (where one already exists) or a DB-migration fallback. A deployment that never opens the new Settings groups behaves identically to today. Specifically:
- Degradation env vars (`DEGRADE_*`) continue to work if no DB value is set
- Retention env vars (`REQUEST_ANALYTICS_*`) continue to work
- The existing `global_retry_limit` DB key is checked as a fallback before the feature-setting DB key

### NFR-2: No Breaking Changes to API Contract
The `GET /api/settings/features` response gains new items in the `settings` array (additive only). The `FeatureSetting` type in `shared/types.ts` gains `options?: string[]`. Clients that don't understand `type: 'string'` gracefully degrade.

### NFR-3: Performance
New settings are resolved via the same `resolveSetting()` path (DB read → env var → default). No additional DB queries per request — degradation config is read once at init, scoring cache lazily refreshes on TTL, ratelimit reads are already per-request.

### NFR-4: Single Source of Truth
After this change, every tunable number lives in the `REGISTRY`. There should be zero remaining `envFloat('DEGRADE_...')` or `readNonNegativeInt('REQUEST_ANALYTICS_...')` calls — they're all replaced by `getFeatureSetting()`. Env vars are the *fallback layer*, not the primary path.

---

## 7. Out of Scope

| Item | Why |
|---|---|
| Routing strategy / custom weights UI | Already well-served on Models page; moving would break muscle memory |
| API key management | Separate concern; lives on Keys page |
| Custom provider CRUD | Separate concern; lives on Keys page |
| Per-model override for any setting | Significant UI complexity; re-visit when demand surfaces |
| Free-text string settings | No current use case; enum is sufficient |
| JSON / object settings | Would require a code editor component; overkill for now |
| Live-effect degradation tuning | Requires refactoring the frozen-config pattern; future spec |
| Real-time settings sync across tabs | Refresh after save is sufficient per original spec |
| Import/export settings | Not needed for a single-instance tool |
| Multi-user / role-based settings ACL | Single-operator tool |
