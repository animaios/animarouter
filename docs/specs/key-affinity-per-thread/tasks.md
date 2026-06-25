# Key Affinity Per Thread — Implementation Tasks

## Task List

### T-1: Add Global Feature Setting
**File:** `server/src/services/feature-settings.ts`
- [ ] Add `key_affinity_enabled` to `REGISTRY` array in "Sessions" group
- [ ] Set type: boolean, default: false, effect: live, envVar: `KEY_AFFINITY_ENABLED`
- [ ] Add appropriate description and label

### T-2: Modify Router Key Selection Logic
**File:** `server/src/services/router.ts`
- [ ] Import `getFeatureSetting` from `../services/feature-settings.js`
- [ ] In `routeRequest()`, read `key_affinity_enabled` setting
- [ ] Implement affinity key selection branch:
  - Compute SHA1 hash of `options.stickySessionKey`
  - Apply modulo against combined healthy+unhealthy keys
  - Select key at deterministic index
  - Do NOT advance `roundRobinIndex` for this model
- [ ] Preserve existing round-robin branch for when affinity is disabled
- [ ] Add console log and SSE publish for affinity selections (`routing.key_affinity_selected`)
- [ ] Remove dependency on `custom_providers.sticky_sessions_enabled` column check

### T-3: Decouple Session Key from Context Handoff
**File:** `server/src/routes/proxy.ts`
- [ ] Import `getFeatureSetting` from `../services/feature-settings.js`
- [ ] Modify `sessionKey` computation logic:
  - `const sessionKey = (getFeatureSetting('key_affinity_enabled') as boolean || handoffMode !== 'off') ? getSessionKey(messages, sessionIdHeader) : '';`
- [ ] Ensure `stickySessionKey` passed to `routeRequest` is non-empty when key affinity is enabled

### T-4: Client Settings Page Integration
**File:** `client/src/pages/SettingsPage.tsx`
- [ ] Add `key_affinity_enabled` to `SettingsPage` state/fetch
- [ ] Add `ToggleSetting` component in "Sessions" group (below "Sticky Sessions")
- [ ] Set description: "Route all requests in the same conversation thread to the same API key. Maximizes cache reuse. Works independently of Context Handoff."
- [ ] Ensure the toggle updates the setting via existing `saveFeatureSettings` API

### T-5: Add SSE Event Type
**File:** `server/src/lib/events.ts` (or wherever SSE events are defined)
- [ ] Add `routing.key_affinity_selected` event type to the event schema
- [ ] Define payload: `{ sessionKey: string; keyId: number; model: string; at: number }`

### T-6: Tests
**Files:** `server/src/__tests__/integration/key-affinity.test.ts` (new)
- [ ] Test: Key affinity enabled + same session key → same key selected deterministically
- [ ] Test: Key affinity enabled + different session keys → different keys selected
- [ ] Test: Key affinity disabled → round-robin behavior unchanged
- [ ] Test: Exhausted key during affinity → falls through to next key
- [ ] Test: Unhealthy keys excluded from affinity selection (healthy-first)
- [ ] Test: Key affinity works for built-in providers (not just custom)

### T-7: Verification
- [ ] Start server with `key_affinity_enabled = false` → verify round-robin works
- [ ] Enable `key_affinity_enabled = true` → send multiple requests with same session → verify same key used
- [ ] Send requests with different first messages → verify different keys selected
- [ ] Verify Settings page toggle persists after reload
- [ ] Verify no behavior change for existing deployments (default false)

## Implementation Order

1. **T-1** → T-2 → T-3 (core backend)
2. **T-4** (frontend)
3. **T-5** (SSE types)
4. **T-6** → T-7 (tests & verification)

## Dependencies

- T-2 depends on T-1 (needs the setting available)
- T-3 depends on T-1 (reads the setting)
- T-4 depends on T-1 (setting exists in API)
- T-6 depends on T-1 through T-5 being complete