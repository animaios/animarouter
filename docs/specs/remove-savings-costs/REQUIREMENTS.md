# Requirements: Remove Cost/Savings Calculator

> **STATUS: COMPLETE** — All changes below have already been applied to `main`.

## Context

AnimaRouter is a free-tier LLM proxy — all models are accessed via free API keys. The analytics dashboard previously showed a misleading "Est. savings" figure that calculated "what the same tokens would have cost on paid APIs." Since the project is fundamentally a free-tier aggregator and users are not paying anything, this metric was nonsensical and has been removed.

## What Was Done

The following changes were already applied to `main`:

### ✅ REQ-1: Savings removed from `/api/analytics/summary`
- `est_savings` SQL expression removed
- `LEFT JOIN models` removed from summary query
- `MIN(r.created_at) as first_request_at` removed
- `FALLBACK_INPUT_PER_M` / `FALLBACK_OUTPUT_PER_M` parameters removed
- `estimatedCostSavings` and `firstRequestAt` removed from JSON response
- Active-provider filtering added (new feature, not part of original spec)

### ✅ REQ-2: Cost removed from `/api/analytics/by-model`
- `est_cost` SQL expression removed
- `LEFT JOIN models` removed from by-model query
- `m.display_name` replaced with `r.model_id` → `displayName: r.model_id`
- `estimatedCost` removed from JSON response
- Active-provider filtering added

### ✅ REQ-3: Model pricing module deleted
- `server/src/db/model-pricing.ts` — deleted
- `applyModelPricing` import and call removed from `migrations.ts`

### ✅ REQ-4: Shared types updated
- `estimatedCostSavings: number` removed from `AnalyticsSummary` interface

### ✅ REQ-5: Client analytics dashboard updated
- `summary30` useQuery block removed
- All savings variables removed (`actualSavings`, `baseSavings`, `spanDays`, etc.)
- "Est. savings" `Stat` card removed
- Grid changed from `lg:grid-cols-6` to `lg:grid-cols-5`
- "Saved" column removed from per-model table

### ✅ REQ-6: Server tests updated
- Savings-specific test cases removed
- `insertTokensRequest` helper **retained** — it is also used by active-provider filtering tests

## Verification (already passing)

- [x] `server/src/db/model-pricing.ts` does not exist
- [x] `/api/analytics/summary` returns JSON without `estimatedCostSavings` and `firstRequestAt`
- [x] `/api/analytics/by-model` returns JSON without `estimatedCost`
- [x] `shared/types.ts` has no `estimatedCostSavings` field
- [x] Client `AnalyticsPage.tsx` does not show an "Est. savings" card
- [x] Client per-model table does not show a "Saved" column
