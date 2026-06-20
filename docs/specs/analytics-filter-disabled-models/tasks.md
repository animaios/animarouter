# Analytics: Hide Disabled Models in Per-Model Breakdown — Tasks

> **Branch:** `feat/analytics-filter-disabled-models`
> **Touch:** Only `server/src/routes/analytics.ts` + `server/src/__tests__/routes/analytics.test.ts`
> **Do NOT touch:** client code, other server routes, DB migrations, other analytics endpoints

---

## Task 1: Add model-level enabled filter to `/by-model` SQL

**File:** `server/src/routes/analytics.ts`

In the `/by-model` handler, add one line to the WHERE clause — immediately after the existing `${pf.sql}` line and before `GROUP BY`:

```sql
AND (m.enabled IS NULL OR m.enabled = 1)
```

The full WHERE clause becomes:

```sql
WHERE r.created_at >= ?
  ${pf.sql}
  AND (m.enabled IS NULL OR m.enabled = 1)
```

**Why `IS NULL OR m.enabled = 1` and not just `m.enabled = 1`?**  
A plain `m.enabled = 1` would exclude untracked models (no `models` row → `m.enabled IS NULL`), because `NULL = 1` evaluates to NULL (falsy). The NULL-safe version preserves untracked models per FR-6.

**Verification:** TypeScript compiles. The `/by-model` endpoint returns data for enabled and untracked models only.

---

## Task 2: Add `describe('disabled model filtering in by-model')` test block

**File:** `server/src/__tests__/routes/analytics.test.ts`

Add a new `describe` block inside the top-level `describe('Analytics API', ...)`, after the existing `describe('active provider filtering', ...)` block.

### Test cases (4 minimum):

| # | Test name | Setup | Assertion |
|---|---|---|---|
| 1 | `excludes disabled model from by-model breakdown` | `insertKey('dm', 1)`, `insertModel('dm', 'active-m', 1)`, `insertModel('dm', 'disabled-m', 0)`. Insert requests for both models. | `byModel` response has 1 row for `active-m` only; `disabled-m` absent |
| 2 | `includes untracked model (no models row) in by-model breakdown` | `insertKey('untracked', 1)`, `insertModel('untracked', 'known-m', 1)`. Insert requests for `known-m` and for `ghost-m` (no `insertModel` call). | Response has 2 rows: `known-m` and `ghost-m` |
| 3 | `re-enabled model appears in by-model breakdown` | `insertKey('retoggle', 1)`, `insertModel('retoggle', 'm1', 0)`. Insert request. Fetch → verify absent. Then `UPDATE models SET enabled = 1 WHERE ...`. Fetch again → verify present with its historical data |
| 4 | `disabled model on active platform does not affect by-platform` | Same setup as test 1. Fetch `/by-platform`. | `byPlatform` still counts ALL requests for the active platform (including the disabled-model requests), because by-platform is platform-level, not model-level |

### Test helper (if needed)

The existing `insertModel(platform, modelId, enabled)` helper already supports the `enabled` parameter. No new helpers needed.

**Verification:** `npm run test -w server -- --run server/src/__tests__/routes/analytics.test.ts` — all pass.

---

## Task 3: Broader test run & regression check

```bash
npm run test -w server -- --run
```

Watch for failures in:
- `server/src/__tests__/routes/analytics.test.ts` — primary
- `server/src/__tests__/integration/full-flow.test.ts` — step 6 checks analytics

If integration tests break, diagnose whether they insert requests for disabled models and fix the test setup (not the code).

---

## Task 4: Final smoke test

```bash
npm run dev
```

1. Open the Analytics tab → Per-model breakdown shows only enabled models.
2. Disable a model in the Keys/Models tab.
3. Return to Analytics → the disabled model no longer appears in the table.
4. Re-enable the model → it reappears with its historical data.

---

## Acceptance Checklist

- [x] `/by-model` endpoint excludes rows where `m.enabled = 0`
- [x] `/by-model` endpoint still includes models with no `models` row (`m.enabled IS NULL`)
- [x] Other 5 analytics endpoints are **unmodified**
- [x] Client `AnalyticsPage.tsx` is **not modified**
- [x] No DB schema changes
- [x] No new dependencies
- [x] 4 new model-filtering tests pass
- [x] Full server test suite passes (1 pre-existing failure in `routing-provider-fastfail.test.ts` — unrelated)
