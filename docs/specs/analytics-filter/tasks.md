# Analytics Provider Filtering — Tasks

> **Branch:** `feat/analytics-filter`
> **Workspace:** `cp -r /home/vi/animarouter /home/vi/animarouter-analytics-filter && cd /home/vi/animarouter-analytics-filter && git checkout -b feat/analytics-filter`
> **Touch:** Only `server/src/routes/analytics.ts` + `server/src/__tests__/routes/analytics.test.ts`
> **Do NOT touch:** client code, other server routes, DB migrations

---

## Task 1: Add helpers to `server/src/routes/analytics.ts`

**After** the `getSinceTimestamp()` function (line ~25), add two new helpers:

### 1a. `getActivePlatforms(db)`

```ts
function getActivePlatforms(db: import('better-sqlite3').Database): string[] {
  return (db.prepare(`
    SELECT DISTINCT k.platform
    FROM api_keys k
    WHERE k.enabled = 1
      AND EXISTS (
        SELECT 1 FROM models m
        WHERE m.platform = k.platform AND m.enabled = 1
      )
  `).all() as { platform: string }[]).map(r => r.platform);
}
```

### 1b. `buildPlatformFilter(activePlatforms, alias?)`

```ts
function buildPlatformFilter(
  activePlatforms: string[],
  alias = '',
): { sql: string; params: string[] } {
  if (activePlatforms.length === 0) return { sql: '', params: [] };
  const col = alias ? `${alias}.platform` : 'platform';
  return {
    sql: `AND ${col} IN (${activePlatforms.map(() => '?').join(',')})`,
    params: activePlatforms,
  };
}
```

### 1c. Define all six empty-response shapes as constants

```ts
const EMPTY_SUMMARY = {
  totalRequests: 0, successRate: 0,
  totalInputTokens: 0, totalOutputTokens: 0,
  avgLatencyMs: 0, estimatedCostSavings: 0,
  pinnedRequests: 0, pinHonoredRequests: 0,
  firstRequestAt: null,
};
const EMPTY_ERROR_DIST = { byCategory: [], byPlatform: [], detailed: [] };
```

**Verification:** TypeScript compiles. Helpers are not yet called from endpoints.

---

## Task 2: Update `GET /api/analytics/summary`

At the top of the handler, after `const db = getDb()`:

```ts
const active = getActivePlatforms(db);
if (active.length === 0) return res.json(EMPTY_SUMMARY);
const pf = buildPlatformFilter(active, 'r');
```

Then modify the SQL:

```sql
WHERE r.created_at >= ?
  ${pf.sql}
```

And update the `.get()` bind params: `[FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since, ...pf.params]`

**Verification:** Manual curl — with no keys in DB, summary returns all zeros. With a groq key enabled, only groq requests count.

---

## Task 3: Update `GET /api/analytics/by-model`

Same pattern — add `getActivePlatforms` + `buildPlatformFilter(active, 'r')` at top.

SQL change: `WHERE r.created_at >= ? ${pf.sql}`

Bind: `[FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since, ...pf.params]`

Empty return: `res.json([])`

---

## Task 4: Update `GET /api/analytics/by-platform`

Add `getActivePlatforms` + `buildPlatformFilter(active)` (no alias — column is just `platform`).

SQL change: `WHERE created_at >= ? ${pf.sql}`

Bind: `[since, ...pf.params]`

Empty return: `res.json([])`

---

## Task 5: Update `GET /api/analytics/timeline`

Add `getActivePlatforms` + `buildPlatformFilter(active)`.

SQL change: `WHERE created_at >= ? ${pf.sql}` (applied to both the GROUP BY and the WHERE — same clause).

Bind: `[since, ...pf.params]`

Empty return: `res.json([])`

---

## Task 6: Update `GET /api/analytics/error-distribution`

Add `getActivePlatforms` + `buildPlatformFilter(active)`.

All three internal queries get `AND platform IN (...)` appended:

- **detailed** query: `WHERE status = 'error' AND created_at >= ? ${pf.sql}`
- **byCategory** query: `WHERE status = 'error' AND created_at >= ? ${pf.sql}`
- **byPlatform** query: `WHERE status = 'error' AND created_at >= ? ${pf.sql}`

Each gets `...pf.params` appended to its bind array.

Empty return: `res.json(EMPTY_ERROR_DIST)`

---

## Task 7: Update `GET /api/analytics/errors`

Add `getActivePlatforms` + `buildPlatformFilter(active)`.

SQL change: `WHERE status = 'error' AND created_at >= ? ${pf.sql}`

Bind: `[since, ...pf.params]`

Empty return: `res.json([])`

---

## Task 8: Update existing analytics tests to seed keys

In `server/src/__tests__/routes/analytics.test.ts`:

### 8a. Add `insertKey()` helper

```ts
function insertKey(platform: string, enabled = 1) {
  const db = getDb();
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', ?)
  `).run(platform, '0'.repeat(64), '0'.repeat(32), '0'.repeat(32), enabled);
}
```

### 8b. Seed keys in `beforeAll` or `beforeEach`

The existing tests insert `requests` rows for platforms like `'test'`, `'groq'`, `'custom'`. These **must** have matching enabled keys or they'll be filtered out.

Minimum required in the existing `beforeEach`:

```ts
// Seed keys so the filter includes these platforms' request data.
insertKey('test', 1);
insertKey('groq', 1);
insertKey('custom', 1);
```

**Check:** Run existing tests. If any existing test inserts `requests` for a platform without a seeded key, add one. The pinned-vs-auto test block may need its own key seeds too.

---

## Task 9: Add new `describe('active provider filtering')` test block

Add after the existing test blocks in `analytics.test.ts`:

### Test cases (7 minimum):

| # | Test name | Setup | Assertion |
|---|---|---|---|
| 1 | `excludes requests from providers with no keys (summary)` | Insert request for `'nokey'` platform (no api_keys row). Call `/summary`. | `totalRequests === other_active_count` (nokey request excluded) |
| 2 | `excludes requests from providers with only disabled keys (summary)` | `insertKey('disabled', 0)`. Insert request for `'disabled'`. Call `/summary`. | `totalRequests` does not include the disabled-platform request |
| 3 | `excludes requests from providers with keys but no enabled models (summary)` | `insertKey('nomodels', 1)`. Ensure no enabled models exist for `'nomodels'`. Insert request. | Request excluded from summary |
| 4 | `includes requests once a key is enabled` | Insert request for `'late'`, `insertKey('late', 0)`. Call `/summary` → verify excluded. Then `UPDATE api_keys SET enabled = 1 WHERE platform = 'late'`. Call `/summary` → verify included. | Toggle works correctly |
| 5 | `filters by-platform endpoint` | Insert requests for `'active'` and `'inactive'` (no keys). | `byPlatform` only contains `'active'` |
| 6 | `filters by-model endpoint` | Same setup. | `byModel` only contains `'active'` models |
| 7 | `filters error-distribution endpoint` | Insert error requests for `'active'` and `'inactive'`. | `errorDist.byPlatform` only contains `'active'` |

**Verification:** `npm run test -w server -- --run server/src/__tests__/routes/analytics.test.ts` — all pass.

---

## Task 10: Broader test run & regression check

```bash
cd /home/vi/animarouter-analytics-filter
npm run test -w server -- --run
```

Watch for failures in:
- `server/src/__tests__/routes/analytics.test.ts`
- `server/src/__tests__/integration/full-flow.test.ts` (step 6 checks analytics)
- Any test that inserts `requests` rows for platforms without keys

If integration tests break because their request data is now filtered, seed keys in their setup too (but scope the fix to the minimum — add `insertKey()` calls only for platforms they actually query).

---

## Task 11: Final smoke test

```bash
npm run dev
```

1. Open the Analytics tab with no keys configured → all zeros / empty states.
2. Add a key for one provider → that provider's historical data appears.
3. Disable the key → provider disappears from all charts instantly.
4. Re-enable → data reappears.

---

## Acceptance Checklist

- [ ] All 6 analytics endpoints filter by active-provider set (enabled key + enabled model)
- [ ] Zero active providers → sensible empty/zero responses, no crash
- [ ] Existing analytics tests pass (after key seeding)
- [ ] 7 new filtering-specific tests pass
- [ ] Full server test suite passes
- [ ] Client `AnalyticsPage.tsx` is **not modified**
- [ ] No DB schema changes
- [ ] No new dependencies
