# Bandit Router — Heartbeat-Based Reliability Redesign — Implementation Tasks

## Overview

This document tracks the heartbeat reliability redesign status. Core router scoring is already implemented; remaining work is limited to performance polish and exposing the new signal in analytics/dashboard surfaces.

Legend:
- `[x]` Implemented
- `[ ]` Remaining

## Phase 1: Core Router Implementation

### Task 1.1: Add `proportionHealthyKeys()` helper

**Status**: `[x]` Implemented

**Location**: `server/src/services/heartbeat.ts`

**Implemented behavior**:
- Exports `proportionHealthyKeys(platform: string, modelId: string): number`
- Queries enabled keys with routable statuses: `healthy`, `unknown`, `error`
- Uses `isKeyHealthy(k.id, modelId)` for per-key-per-model health
- Returns `0` when no keys exist for the platform
- Returns a `0..1` ratio for healthy keys

**Coverage**:
- `server/src/__tests__/services/heartbeat.test.ts` covers empty key sets, routable status filtering, mixed health, all-healthy, and all-sick cases.

---

### Task 1.2: Add `heartbeatReliability()` helper

**Status**: `[x]` Implemented

**Location**: `server/src/services/heartbeat.ts`

**Implemented behavior**:
- Exports `heartbeatReliability(platform: string, modelId: string): number`
- Calls `proportionHealthyKeys()` and scales the result to `[0, 100]`
- Returns `100` when all routable keys are healthy
- Returns `0` when all routable keys are sick or no keys exist
- Returns linear interpolation for mixed health

**Coverage**:
- `server/src/__tests__/services/heartbeat.test.ts` covers the boundary and mixed-ratio cases.

---

### Task 1.3: Update `scoreChainEntry()`

**Status**: `[x]` Implemented

**Location**: `server/src/services/router.ts`

**Implemented behavior**:
- Uses `heartbeatReliability(entry.platform, entry.model_id) / 100` when `isHeartbeatEnabled()` is true
- Falls back to historical reliability when heartbeat is disabled
- Preserves Thompson sampling when heartbeat is disabled and sampled bandit ordering is active
- Passes the reliability axis through `combineScore()` as before

**Coverage**:
- `server/src/__tests__/services/router-bandit.test.ts` verifies heartbeat reliability overrides historical request stats when enabled and historical reliability is used when heartbeat is disabled.

---

### Task 1.4: Update `providerSubScore()`

**Status**: `[x]` Implemented

**Location**: `server/src/services/router.ts`

**Implemented behavior**:
- Uses `heartbeatReliability(provider.platform, provider.model_id) / 100` when `isHeartbeatEnabled()` is true
- Falls back to historical reliability when heartbeat is disabled
- Preserves sampled Beta reliability for sampled bandit ordering when heartbeat is disabled
- Preserves existing healthy-key-first routing logic

**Coverage**:
- `server/src/__tests__/services/router-grouping.test.ts` verifies grouped providers sort by heartbeat reliability when heartbeat is enabled.

---

## Phase 2: Performance Optimization

### Task 2.1: Cache `proportionHealthyKeys()` results

**Status**: `[ ]` Remaining

**Location**: `server/src/services/router.ts` or a small helper in `server/src/services/heartbeat.ts`

**Work**:
- Cache per-platform/model proportions during one scoring run
- Avoid repeated DB queries and `isKeyHealthy` checks when the same platform/model is scored more than once
- Keep cache lifetime scoped to score computation; do not let stale health leak across heartbeat changes

**Acceptance**:
- Same score output as the uncached implementation
- No extra stale-health window beyond the existing score cache behavior
- Tests or instrumentation show duplicate platform/model scoring reuses the computed proportion

---

## Phase 3: Testing

### Task 3.1: Unit tests for heartbeat reliability helpers

**Status**: `[x]` Implemented

**Location**: `server/src/__tests__/services/heartbeat.test.ts`

**Coverage**:
- Empty key set
- All healthy
- All sick
- Mixed healthy/sick ratios
- Routable status filtering for `healthy`, `unknown`, and `error`
- Exclusion of `sick` and disabled keys from the denominator

---

### Task 3.2: Router scoring tests

**Status**: `[x]` Implemented

**Locations**:
- `server/src/__tests__/services/router-bandit.test.ts`
- `server/src/__tests__/services/router-grouping.test.ts`

**Coverage**:
- Heartbeat reliability overrides historical stats when heartbeat is enabled
- Historical reliability is used when heartbeat is disabled
- Grouped provider ordering respects heartbeat reliability

---

### Task 3.3: End-to-end toggle test

**Status**: `[ ]` Remaining

**Work**:
- Start server with heartbeat disabled and confirm historical behavior
- Enable heartbeat and confirm live health changes affect scoring
- Toggle during runtime and confirm the router switches behavior without restart-only assumptions

**Acceptance**:
- End-to-end test passes against the public API route
- Confirms the feature flag can be changed safely at runtime

---

## Phase 4: Analytics and Dashboard Exposure

### Task 4.1: Add heartbeat reliability to analytics API

**Status**: `[ ]` Remaining

**Location**: `server/src/routes/analytics.ts`

**Work**:
- Add `heartbeat_reliability` to `/api/analytics/by-model`
- Keep the existing `reliability` field backward compatible
- Decide whether to return `null` or omit `heartbeat_reliability` when heartbeat is disabled

**Acceptance**:
- API returns heartbeat reliability when enabled
- Existing analytics clients continue to work without changes
- Route tests cover enabled and disabled heartbeat modes

---

### Task 4.2: Update dashboard UI

**Status**: `[ ]` Remaining

**Location**: `client/src/pages/AnalyticsPage.tsx`

**Work**:
- Display heartbeat reliability alongside historical reliability
- Show healthy/sick key counts for each model if the API exposes them
- Keep the table readable on narrow viewports

**Acceptance**:
- Dashboard clearly distinguishes live heartbeat reliability from historical request reliability
- The UI handles disabled heartbeat and missing fields gracefully

---

## Phase 5: Documentation

### Task 5.1: Keep this spec aligned with implementation

**Status**: `[x]` Implemented

**Work**:
- Mark completed core implementation tasks as done
- Document that sampled Beta reliability remains the heartbeat-disabled fallback
- Correct the analytics endpoint name to `/api/analytics/by-model`

---

### Task 5.2: Update routing strategy docs

**Status**: `[ ]` Remaining

**Work**:
- Document that the reliability axis comes from heartbeat when `heartbeat_enabled = true`
- Explain how cold, sick, and healthy keys affect scoring
- Add examples for mixed key health

**Acceptance**:
- User-facing routing docs describe both heartbeat-enabled and heartbeat-disabled behavior

---

## Phase 6: Cleanup and Verification

### Task 6.1: Remove only genuinely unused code

**Status**: `[ ]` Remaining as-needed

**Work**:
- Run typecheck/tests after any implementation follow-up
- Remove imports only when the compiler or linter proves they are unused
- Do not remove historical reliability helpers while heartbeat-disabled fallback still depends on them

---

### Task 6.2: Run full test suite

**Status**: `[ ]` Remaining for the next implementation change

**Work**:
- Run `npm run test`
- Fix any failing tests
- Verify no regressions

---

## Remaining Implementation Order

1. **Task 2.1** — Cache heartbeat reliability proportions if profiling shows duplicate scoring work.
2. **Task 4.1** — Add `heartbeat_reliability` to `/api/analytics/by-model`.
3. **Task 4.2** — Display heartbeat reliability in the dashboard.
4. **Task 3.3** — Add end-to-end runtime toggle coverage.
5. **Task 5.2** — Update user-facing routing docs.
6. **Task 6.2** — Run the full test suite for the implementation follow-up.

---

## Rollback Plan

If heartbeat reliability causes routing issues:
1. Set `heartbeat_enabled = false` to return to historical reliability without code changes.
2. If a code rollback is required, revert the router scoring calls while keeping helper tests and docs as reference.
3. No database migration rollback is needed; the redesign uses runtime state and existing settings.
