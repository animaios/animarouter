# Design: Remove Cost/Savings Calculator

> **STATUS: COMPLETE** — All changes described below have already been applied to `main`.

## Overview

This document records the surgical removal of cost/savings calculation from the AnimaRouter stack. The change spanned 6 files across server, client, shared types, and tests. No new code was introduced — only deletion and minimal rewrites.

## Files Changed

| File | Action | Status |
|------|--------|--------|
| `server/src/db/model-pricing.ts` | **DELETED** | ✅ Done |
| `server/src/db/migrations.ts` | **EDIT** — remove `applyModelPricing` import/call | ✅ Done |
| `server/src/routes/analytics.ts` | **EDIT** — remove savings/cost from endpoints | ✅ Done |
| `shared/types.ts` | **EDIT** — remove `estimatedCostSavings` from interface | ✅ Done |
| `client/src/pages/AnalyticsPage.tsx` | **EDIT** — remove savings card, variables, column | ✅ Done |
| `server/src/__tests__/routes/analytics.test.ts` | **EDIT** — remove savings tests | ✅ Done |

## What Was Removed

### `server/src/db/model-pricing.ts` (deleted)
- `MODEL_PRICING` array — per-model paid-API rates (183 rows)
- `FALLBACK_INPUT_PER_M` / `FALLBACK_OUTPUT_PER_M` constants
- `applyModelPricing(db)` function — added columns and updated prices at boot

### `server/src/db/migrations.ts`
- Removed `import { applyModelPricing } from './model-pricing.js'`
- Removed `applyModelPricing(db)` call

### `server/src/routes/analytics.ts`
**`/summary` endpoint:**
- Removed `est_savings` SQL expression
- Removed `LEFT JOIN models m`
- Removed `MIN(r.created_at) as first_request_at`
- Removed `FALLBACK_INPUT_PER_M` / `FALLBACK_OUTPUT_PER_M` params from `.get()`
- Removed `estimatedCostSavings` and `firstRequestAt` from response
- Added active-provider filtering (`getActivePlatforms` / `buildPlatformFilter`)

**`/by-model` endpoint:**
- Removed `est_cost` SQL expression  
- Removed `LEFT JOIN models m`
- Removed `m.display_name` — now uses `displayName: r.model_id`
- Removed `estimatedCost` from response
- Added active-provider filtering

### `shared/types.ts`
- Removed `estimatedCostSavings: number` from `AnalyticsSummary`

### `client/src/pages/AnalyticsPage.tsx`
- Removed `summary30` useQuery
- Removed `actualSavings`, `baseSavings`, `spanDays`, `extrapolated`, `savings30d`, `rangeLabel`, `spanLabel`, `savingsHint`
- Removed "Est. savings" `Stat` card
- Changed grid: `lg:grid-cols-6` → `lg:grid-cols-5`
- Removed "Saved" `TableHead` and `TableCell`
- Added `pr-4` to "Out tokens" header (now last column)

### `server/src/__tests__/routes/analytics.test.ts`
- Removed 4 savings test cases
- `insertTokensRequest` helper **retained** — used by active-provider filtering tests

## Known Trade-off

Removing `LEFT JOIN models m` and `m.display_name` means the per-model breakdown table shows raw model IDs (e.g. `llama-3.3-70b-versatile`) instead of human-friendly display names. This was accepted as a reasonable tradeoff since the JOIN only existed to support pricing; a future feature could re-add display names via a different mechanism if needed.
