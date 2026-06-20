# Expanded Settings — Task Breakdown

## Phase 1: Schema & Registry (no behavior change)

- [ ] **T1.1** Extend `FeatureSettingDef` type in `server/src/services/feature-settings.ts` — add `'string'` to `type` union, add `options?: string[]`, widen `default` to `boolean | number | string`
- [ ] **T1.2** Extend `FeatureSetting` in `shared/types.ts` — same changes (`type`, `value`, `default` widen; add `options`)
- [ ] **T1.3** Update `resolveSetting()` in `feature-settings.ts` — handle `type === 'string'` (return DB/env value as-is, or `def.default`)
- [ ] **T1.4** Update `saveFeatureSettings()` validation — add string type check and `options` enum validation
- [ ] **T1.5** Add all 16 new entries to `REGISTRY` array (copy from design doc §2.2)
- [ ] **T1.6** Run `npm run test -w server` — should pass (new settings are inert until consumers read them)

## Phase 2: Server Constant Migration

- [ ] **T2.1** Migrate `ratelimit.ts` — replace `TRANSIENT_COOLDOWN_MS`, `PAYMENT_REQUIRED_COOLDOWN_MS`, `MODEL_FORBIDDEN_COOLDOWN_MS` with getter functions backed by `getFeatureSetting()`; update `computeRetryCooldownMs`, `getCooldownDurationForLimit`, and all other references
- [ ] **T2.2** Migrate `degradation.ts` — replace `envFloat`/`envMinutesToMs`/`envInt` calls in `initDegradation()` with `getFeatureSetting()` for the 6 surfaced settings; keep remaining niche env vars (`DEGRADE_MINOR_WEIGHT` etc.) as `envFloat()` fallback but route through `getFeatureSetting()` so they're in the registry
- [ ] **T2.3** Migrate `context-handoff.ts` — replace `process.env.API_GATEWAY_CONTEXT_HANDOFF` with `getFeatureSetting('context_handoff_mode')`; replace `SESSION_TTL_MS` constant with `getSessionTtlMs()`
- [ ] **T2.4** Migrate `proxy.ts` — replace `STICKY_TTL_MS` constant with `getStickyTtlMs()`
- [ ] **T2.5** Migrate `router.ts` — replace `WINDOW_MS`, `HALF_LIFE_DAYS`, `CACHE_TTL_MS` with getter functions; migrate `getGlobalRetryLimit()` to use `getFeatureSetting('global_retry_limit')` with the existing `getSetting('global_retry_limit')` as fallback
- [ ] **T2.6** Migrate `request-retention.ts` — replace `readNonNegativeInt()` env var reads with `getFeatureSetting()`; simplify `getRequestAnalyticsRetentionConfig()`
- [ ] **T2.7** Run `npm run test -w server` — all existing tests must pass; degradation/ratelimit/router tests may need import path updates

## Phase 3: Client String-Enum Support

- [ ] **T3.1** Update `FeatureSetting` type in `client/src/lib/api.ts` — widen `value`/`default` to include `string`, add `options` field
- [ ] **T3.2** Update `SettingsPage.tsx` — widen `localValues` type to `Record<string, boolean | number | string>`
- [ ] **T3.3** Update `setting-row.tsx` — add `<Select>` (shadcn) branch for `type === 'string'` with `options`; widen `onChange` handler to accept `string`
- [ ] **T3.4** Verify all existing boolean/number rows still render correctly

## Phase 4: Fallback Page Cleanup

- [ ] **T4.1** Remove retry-limit UI from Fallback page (`client/src/pages/FallbackPage.tsx` or equivalent)
- [ ] **T4.2** Remove or redirect `PUT /api/fallback/retry-limit` in `server/src/routes/fallback.ts` — check `find_references('retry-limit')` for any other consumers first
- [ ] **T4.3** Run `npm run test -w server` — verify no broken references

## Phase 5: Tests

- [ ] **T5.1** Add unit tests for string enum resolution and validation in `feature-settings.test.ts`
- [ ] **T5.2** Add migration verification tests for `degradation.ts` (set DB value → `initDegradation()` → verify config)
- [ ] **T5.3** Add migration verification tests for `ratelimit.ts` (set DB value → `computeRetryCooldownMs()` → verify result)
- [ ] **T5.4** Add migration verification tests for `context-handoff.ts` (set `context_handoff_mode` + `session_ttl_min` → verify behavior)
- [ ] **T5.5** Add integration test: save setting via PUT → GET reflects it → pendingRestart for restart-effect settings
- [ ] **T5.6** Full test run: `npm run test`

## Phase 6: Final Validation

- [ ] **T6.1** `npm run build` — both server and client must compile cleanly
- [ ] **T6.2** `npm run dev` — open Settings page, verify 6 groups render with all 22 settings
- [ ] **T6.3** Manual smoke test: change a `live` setting (retry limit), verify immediate effect on next request
- [ ] **T6.4** Manual smoke test: change a `restart` setting (degradation half-life), verify restart-required banner
