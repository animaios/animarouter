# Tasks — Model Grouping

---

## Phase 1: DB Schema + Migration

### Task 1.1 — V38 Migration (model_groups, aliases, group_id)
**Dependencies:** None
**Files:** `server/src/db/migrations.ts`
**Symbol to create:** `migrateModelsV38ModelGroups` (new function)
**Context symbols:**
- `server/src/db/migrations.ts::ensureBenchmarkUnificationColumns#function`
- `server/src/db/migrations.ts::migrateModelsV37MultiSourceBenchmarks#function`

**Work:**
1. Create `model_groups` table (D3.1 schema).
2. Create `model_group_aliases` table (D3.2 schema).
3. `ALTER TABLE models ADD COLUMN group_id INTEGER REFERENCES model_groups(id)`.
4. `ALTER TABLE fallback_config ADD COLUMN group_id INTEGER REFERENCES model_groups(id)`.
5. For each distinct `canonical_model_key` in `models`:
   - Create a `model_groups` row with properties from the highest-benchmarked model row with that key.
6. Seed `model_group_aliases` from the R2.4 table.
7. Re-resolve models whose alias maps them to a different group than their raw canonical key.
8. Backfill `models.group_id` by joining on `model_groups.group_key`.
9. For each distinct `models.group_id`, insert a `fallback_config` row referencing `group_id` with priority = min of member model priorities.
10. Call `propagateGroupProperties()` for all groups.
11. Add `model_grouping_enabled` setting to `settings` table with default `'false'`.
12. Log `✅ V38: Model grouping — model_groups, aliases, group_id columns created`.

**Validation:**
- `SELECT COUNT(*) FROM model_groups` > 0
- Every `models` row has a non-null `group_id`
- Every `fallback_config` row has a non-null `group_id`
- `SELECT * FROM model_group_aliases LIMIT 5` returns seeded rows

---

### Task 1.2 — Group Resolution Module
**Dependencies:** Task 1.1
**Files:** `server/src/db/model-groups.ts` (**NEW**)
**Symbols to create:**
- `resolveGroupKey(modelId: string, aliasCache: Map<string, string>): string`
- `loadAliasCache(db: Database): Map<string, string>`
- `aliasCache: Map<string, string> | null` (module-level, lazy)
- `invalidateAliasCache(): void`

**Context symbols:**
- `server/src/db/benchmark-scores.ts::canonicalizeModelId#function`
- `server/src/db/benchmark-scores.ts::backfillCanonicalKeys#function`

**Work:**
1. Implement `resolveGroupKey()` per D4: normalize → alias lookup → fallback.
2. Implement `loadAliasCache()`: `SELECT alias, group_key FROM model_group_aliases` → `Map`.
3. Module-level cache with lazy init + `invalidateAliasCache()` for alias CRUD.
4. Export all functions.

**Validation:** Unit tests:
- `resolveGroupKey("opencode-zen/deepseek-v4-flash-free", cache)` → `"deepseek-v4-flash"`
- `resolveGroupKey("nim/deepseek-v4-flash", cache)` → `"deepseek-v4-flash"`
- `resolveGroupKey("custom/new-model", emptyCache)` → `"new-model"` (fallback)

---

### Task 1.3 — Property Propagation
**Dependencies:** Task 1.1
**Files:** `server/src/db/model-groups.ts` (**extend**)
**Symbol to create:** `propagateGroupProperties(db, groupId): void`

**Work:**
1. Implement `propagateGroupProperties()` per D5.
2. SQL: `UPDATE models SET display_name, benchmark_score, intelligence_rank, size_label, context_window, max_output_tokens, supports_vision, supports_tools WHERE group_id = ?`.
3. Log the number of rows propagated at `info` level.

**Validation:** After calling `propagateGroupProperties(db, 1)`, `SELECT benchmark_score FROM models WHERE group_id = 1` returns the same value as `SELECT benchmark_score FROM model_groups WHERE id = 1`.

---

### Task 1.4 — Reconciliation
**Dependencies:** Tasks 1.2, 1.3
**Files:** `server/src/db/model-groups.ts` (**extend**)
**Symbol to create:** `reconcileGroups(db): { groupsCreated: number; modelsReassigned: number }`

**Work:**
1. Scan all `models` rows.
2. For each model, resolve its group_key via `resolveGroupKey()`.
3. If the resolved group_key differs from current `model_groups.group_key` where `models.group_id` points → reassign.
4. If no `model_groups` row exists for the key → create one (properties from model row).
5. Apply property reconciliation rules per D12 (MAX for context_window, OR for vision/tools, etc.).
6. Call `propagateGroupProperties()` for each affected group.
7. Return counts for observability.

**Validation:** Run against a DB where two models with different canonical keys share an alias → both end up in the same group with correct reconciled properties.

---

## Phase 2: Benchmark Pipeline Migration

### Task 2.1 — Move AA Fetch to Group-Level Writes
**Dependencies:** Task 1.1
**Files:** `server/src/db/benchmark-scores.ts`
**Symbol to edit:** `fetchAAScores#function`

**Work:**
1. Change AA SQL to write `aa_score`, `aa_score_updated`, `aa_confidence` to `model_groups` instead of `models`.
2. Match via `model_groups.group_key` instead of `models.canonical_model_key`.
3. Return `affectedGroupIds: Set<number>` instead of `affectedIds: Set<number>`.
4. After upsert, call `propagateGroupProperties(db, groupId)` for each affected group.

**Validation:** After `fetchAAScores`, `model_groups.aa_score` populated, `models.aa_score` propagated from group.

---

### Task 2.2 — Move SWE Fetch to Group-Level Writes
**Dependencies:** Task 1.1
**Files:** `server/src/services/benchmarks.ts`
**Symbol to edit:** `BenchmarkService.fetchSWERebenchScores#method`

**Work:**
1. Change SWE SQL to write per-source columns to `model_groups` instead of `models`.
2. Match via `model_groups.group_key` instead of `models.canonical_model_key`.
3. Return `affectedGroupIds: Set<number>`.
4. Call `propagateGroupProperties()` after writes.

**Validation:** SWE fetch populates `model_groups.swe_rebench_score`, propagates to member models.

---

### Task 2.3 — Move NIM Fetch to Group-Level Writes
**Dependencies:** Task 1.1
**Files:** `server/src/services/benchmarks.ts`
**Symbol to edit:** `BenchmarkService.fetchNIMBenchmarks#method`

**Work:**
1. Change NIM SQL to write `nim_score`, `nim_avg_response_ms`, `nim_throughput_tps`, `nim_uptime_pct` to `model_groups` instead of `models`.
2. Match via `model_groups.group_key`.
3. Return `affectedGroupIds: Set<number>`.
4. Call `propagateGroupProperties()` after writes.

**Validation:** NIM fetch populates `model_groups.nim_*`, propagates to member models.

---

### Task 2.4 — Update recomputeBenchmarkComposite for Groups
**Dependencies:** Tasks 2.1, 2.2, 2.3
**Files:** `server/src/db/benchmark-scores.ts`
**Symbol to edit:** `recomputeBenchmarkComposite#function`

**Work:**
1. Change function signature: `affectedGroupIds: Set<number>` instead of `affectedIds: Set<number>`.
2. Read per-source scores from `model_groups` table instead of `models`.
3. Write `benchmark_score` to `model_groups`.
4. After composite update, call `propagateGroupProperties(db, groupId)` for each affected group.
5. Derive `size_label` and `intelligence_rank` on `model_groups` from the new `benchmark_score`.
6. Also update `benchmark_composite_version` on `model_groups`.

**Validation:** Unit test: after `recomputeBenchmarkComposite`, `model_groups.benchmark_score` computed, `models.benchmark_score` matches for all group members.

---

### Task 2.5 — Update Static Fallback Table Application
**Dependencies:** Task 1.1
**Files:** `server/src/db/benchmark-scores.ts`
**Symbol to edit:** `applyBenchmarkScores#function`, `lookupBenchmarkScore#function`

**Work:**
1. `applyBenchmarkScores()` writes to `model_groups` instead of `models`.
2. Match via `model_groups.group_key` using `canonicalizeModelId()` from each `model_groups.group_key`.
3. Call `propagateGroupProperties()` after batch update.

**Validation:** On a fresh DB, after `applyBenchmarkScores()`, both `model_groups.benchmark_score` and `models.benchmark_score` are populated.

---

## Phase 3: Routing Integration

### Task 3.1 — Group-Aware Chain Builder
**Dependencies:** Tasks 1.1, 1.2
**Files:** `server/src/services/router.ts`
**Symbols to create:**
- `GroupChainRow#type`
- `ProviderRow#type`
- `buildGroupChain(db): GroupChainRow[]`
- `loadGroupProviders(db, groupId): ProviderRow[]`

**Context symbols:**
- `server/src/services/router.ts::ChainRow#type`
- `server/src/services/router.ts::routeRequest#function`

**Work:**
1. Define `GroupChainRow` type (group_id, priority, group_key, display_name, benchmark_score, intelligence_rank, size_label, context_window, supports_vision, supports_tools).
2. Define `ProviderRow` type (model_db_id, platform, model_id, speed_rank, rpm/rpd/tpm/tpd_limit, key_id, enabled, supports_vision, supports_tools).
3. Implement `buildGroupChain()`: SELECT from `fallback_config` JOIN `model_groups` on `group_id`.
4. Implement `loadGroupProviders()`: SELECT from `models` WHERE `group_id = ?` AND `enabled = 1`.
5. Gated by `model_grouping_enabled` setting; when off, fall back to existing `ChainRow` flow.

**Validation:** `buildGroupChain()` returns groups in priority order. `loadGroupProviders()` returns all enabled providers for a group.

---

### Task 3.2 — Within-Group Provider Scoring
**Dependencies:** Task 3.1
**Files:** `server/src/services/router.ts`
**Symbols to create:**
- `providerScore(entry, weights, strategy): number`

**Context symbols:**
- `server/src/services/scoring.ts::combineScore#function`
- `server/src/services/scoring.ts::scoreChainEntry#function`

**Work:**
1. Implement `providerScore()` per D6.4: speed + latency + reliability weighted, intelligence zeroed, re-normalized, multiplied by degradation factor.
2. Add to `scoring.ts` if preferred (for reuse from tests).

**Validation:** Unit test: a provider with high speed and zero degradation outscores a slow degraded provider within the same group.

---

### Task 3.3 — Group-Aware routeRequest()
**Dependencies:** Tasks 3.1, 3.2
**Files:** `server/src/services/router.ts`
**Symbol to edit:** `routeRequest#function`

**Work:**
1. When `model_grouping_enabled` is `true`:
   - Use `buildGroupChain()` instead of existing chain query.
   - For each group in chain order:
     - Load providers via `loadGroupProviders()`.
     - Filter by keys, vision, tools, context window (same guards as current).
     - Sub-score providers with `providerScore()`.
     - Try providers in order until one succeeds.
   - If all providers in group fail, move to next group.
2. When `model_grouping_enabled` is `false`: existing flow unchanged.
3. Model pinning: resolve `model` field to `group_key` via `resolveGroupKey()`, then pin to group.
4. Return `RouteResult` with added `groupId` field.

**Validation:**
- Grouping enabled: request for DeepSeek V4 Flash tries NV first (if higher sub-score), then Zen if NV fails.
- Grouping disabled: identical behavior to current.
- Pinned model resolves to group when using group_key form.

---

### Task 3.4 — Group-Level Chain Ordering
**Dependencies:** Task 3.1
**Files:** `server/src/services/router.ts`
**Symbols to create:**
- `orderGroupChain(chain, strategy): GroupChainRow[]`

**Work:**
1. Implement `groupRepresentativeScore()` per D7: for each group, compute the best-provider full composite, use that as the group's score.
2. Sort groups by score (descending for bandit strategies, ascending for priority).
3. Integrate into `routeRequest()` group iteration.

**Validation:** A group with a fast, healthy DeepSeek V4 Flash provider ranks higher than a group with a slow, degraded one — but both still rank above a group serving a smaller model.

---

## Phase 4: API + Dashboard

### Task 4.1 — Grouped Models API
**Dependencies:** Task 1.1
**Files:** `server/src/routes/models.ts`
**Symbols to edit:** `modelsRouter.get('/')`

**Work:**
1. When `model_grouping_enabled` is `true` or `?groupBy=model`:
   - Query `model_groups` JOIN `fallback_config` JOIN `models`.
   - Build grouped response per D9.1 (groupId, groupKey, displayName, providers[], ...).
   - Include degradation state per provider via `getPenalty()`.
2. When `?flat=true`: return current flat shape (unchanged).
3. Default behavior controlled by feature flag.

**Validation:** `GET /api/models` with grouping returns one entry per model with nested providers array.

---

### Task 4.2 — Groups Debug API
**Dependencies:** Task 1.1
**Files:** `server/src/routes/models.ts`
**Symbols to create:** `modelsRouter.get('/groups')`

**Work:**
1. New endpoint `GET /api/models/groups` per D9.2.
2. Returns group map with group_key, member count, aliases, provider list.
3. No auth change (same admin auth as other model endpoints).

**Validation:** Response format matches D9.2.

---

### Task 4.3 — Alias Management API
**Dependencies:** Tasks 1.1, 1.2
**Files:** `server/src/routes/models.ts`
**Symbols to create:**
- `modelsRouter.post('/groups/aliases')` — add alias
- `modelsRouter.delete('/groups/aliases/:alias')` — remove alias
- `modelsRouter.patch('/groups/:groupKey')` — edit group properties

**Work:**
1. `POST /api/models/groups/aliases`: validate alias, insert into `model_group_aliases`, invalidate cache, trigger `reconcileGroups()`.
2. `DELETE /api/models/groups/aliases/:alias`: delete row, invalidate cache, trigger reconciliation.
3. `PATCH /api/models/groups/:groupKey`: update group-level properties, propagate to models, return affected count.
4. Cycle detection on alias insert (walk chain to ensure no A → B → A).

**Validation:**
- Adding an alias that would create a cycle returns 400.
- Adding a valid alias triggers reconciliation and returns `reassignedModels` count.

---

### Task 4.4 — Analytics Grouped Query
**Dependencies:** Task 1.1
**Files:** `server/src/routes/analytics.ts`
**Symbol to create:** group-by-model query mode

**Work:**
1. Add `?groupBy=model` parameter to analytics endpoints.
2. When set: JOIN `requests` → `models` → `model_groups` on `group_id`, aggregate by `group_key`.
3. Include `providers[]` breakdown with per-provider request count, speed, latency.
4. Default (no param): unchanged behavior.

**Validation:** `GET /api/analytics?groupBy=model` returns aggregated stats per model group.

---

### Task 4.5 — Grouped Routing Scores API
**Dependencies:** Task 3.1
**Files:** `server/src/routes/fallback.ts`
**Symbol to edit:** performanceData constant, routing scores endpoint

**Work:**
1. When grouping enabled: `GET /api/fallback/routing` returns grouped scores per D9.6.
2. Each group shows `groupScore` + per-provider `subScore` + degradation info.
3. When grouping disabled: unchanged.

**Validation:** Response includes groupKey, groupScore, providers with subScores.

---

### Task 4.6 — Dashboard FallbackPage UI
**Dependencies:** Task 4.1
**Files:** `client/src/pages/FallbackPage.tsx`
**Context symbols:**
- `client/src/pages/FallbackPage.tsx::EditModelModal`

**Work:**
1. Render model groups as expandable cards.
2. Collapsed: group displayName, intelligence badge, tier label, worst degradation indicator, provider count chip.
3. Expanded: per-provider table (platform, speed rank, key count, degradation tier, enabled toggle).
4. Group-level actions: enable/disable group, edit group properties, reorder group in chain.
5. Per-provider actions: enable/disable provider, see degradation details.
6. Use `?groupBy=model` API when grouping feature is enabled.
7. Fall back to flat rendering when grouping disabled.

**Validation:** UI shows "DeepSeek V4 Flash" as one card with 2 providers (NIM, OpenCode Zen) instead of 2 separate rows.

---

### Task 4.7 — Model Search Box Updates
**Dependencies:** Task 4.1
**Files:** `client/src/components/model-search-box.tsx`

**Work:**
1. When grouping enabled: search returns groups, not individual models.
2. Selecting a group in the playground/composer sets `model` to the `groupKey`.
3. Show provider badge count next to group name.
4. Keyboard navigation works per-group.

**Validation:** Searching "deepseek" shows "DeepSeek V4 Flash (2 providers)" instead of two separate entries.

---

## Phase 5: Auto-Sync + Custom Provider Integration

### Task 5.1 — Auto-Sync Group Assignment
**Dependencies:** Tasks 1.2, 1.4
**Files:** `server/src/routes/custom.ts`
**Symbol to edit:** `syncModelsFromProvider#function`

**Work:**
1. After creating/updating a model row from auto-sync, run `resolveGroupKey(modelId, aliasCache)`.
2. Look up `model_groups` by `group_key`. If found, assign `group_id`. If not, `reconcileGroups()` creates the group.
3. Group-level properties are NOT overwritten by auto-sync. Provider-level properties (speed_rank, limits) are updated normally.
4. Log the group assignment.

**Validation:** Auto-syncing a custom provider that offers `deepseek-v4-flash` assigns the model to the existing DeepSeek V4 Flash group.

---

### Task 5.2 — Custom Model Creation with Group Assignment
**Dependencies:** Task 5.1
**Files:** `server/src/routes/custom.ts`

**Work:**
1. The `addModel` mutation resolves group assignment for custom models.
2. If the model joins an existing group, inherit group-level properties (ignore user-provided intelligence_rank, benchmark_score).
3. If no group exists, create one from user-provided properties.

**Validation:** Adding a custom model "deepseek-v4-flash" on a custom provider auto-joins the existing group.

---

## Phase 6: Tests & Cleanup

### Task 6.1 — Migration Tests
**Dependencies:** Task 1.1

**Work:**
1. Test migration idempotency (run twice → same result).
2. Test group creation from migrated data: every model has a group_id.
3. Test alias seeding: expected aliases present.
4. Test fallback_config migration: group_id populated, priority derived correctly.
5. Test rollback: drop V38 tables, verify old paths still work.

**Validation:** `npm test` passes.

---

### Task 6.2 — Resolution & Propagation Tests
**Dependencies:** Tasks 1.2, 1.3

**Work:**
1. Test `resolveGroupKey()` with alias matches, fallback cases, unknown models.
2. Test `propagateGroupProperties()`: group change propagates to all member models.
3. Test `reconcileGroups()`: model reassigned when alias added, group properties reconciled.
4. Test property disagreement resolution (MAX for context_window, OR for vision/tools).
5. Test alias cycle detection.

**Validation:** All new unit tests pass.

---

### Task 6.3 — Routing Integration Tests
**Dependencies:** Tasks 3.1, 3.2, 3.3

**Work:**
1. Test group-aware routing: request routes to best provider within group.
2. Test within-group failover: first provider fails, second succeeds without moving to next group.
3. Test group-level failover: all providers in group fail, next group tried.
4. Test model pinning with group_key resolution.
5. Test feature flag off: identical behavior to current routing.
6. Test degradation isolation: NV degraded ≠ Zen degraded for same model group.

**Validation:** Integration tests pass.

---

### Task 6.4 — API Tests
**Dependencies:** Tasks 4.1–4.5

**Work:**
1. Test grouped `GET /api/models` response shape.
2. Test flat `GET /api/models?flat=true` unchanged.
3. Test `GET /api/models/groups` debug map.
4. Test alias CRUD endpoints.
5. Test group property edit + propagation.
6. Test analytics `?groupBy=model` aggregation.
7. Test grouped routing scores response.

**Validation:** All API tests pass.

---

### Task 6.5 — Existing Test Compatibility
**Dependencies:** All Phase 1–5 tasks

**Work:**
1. Update all existing tests that INSERT into `models` to also provide `group_id` (or let reconciliation backfill).
2. Update tests that assert on `fallback_config.model_db_id` to also check `group_id` when grouping is enabled.
3. Ensure scoring tests still pass (intelligence composite reads from model groups).
4. No behavioral changes in test expectations when grouping is disabled.

**Validation:** Full test suite passes with grouping enabled and disabled.

---

## Execution Order

```
Phase 1:  Task 1.1 (V38 migration)
                │
           ┌────┼──────────┐
           │ Task 1.2      │ Task 1.3
           │ Resolution     │ Propagation
           └────┬──────────┘
                │
           Task 1.4 (reconciliation)
                │
Phase 2:  ┌────┼──────────┬──────────┐
           │ 2.1 │ 2.2     │ 2.3     │ 2.5
           │ AA   │ SWE     │ NIM     │ Static
           └────┬─┴────┬───┴────┬────┘
                │      │        │
           Task 2.4 (composite for groups)
                │
Phase 3:  ┌────┼──────────┐
           │ 3.1 │ 3.2     │
           │ Chain │ Provider│
           │ Build │ Score   │
           └────┬─┴────┬───┘
                │      │
           Task 3.3 (routeRequest)
           Task 3.4 (chain ordering)
                │
Phase 4:  ┌────┼──────────┬──────────┬──────────┐
           │ 4.1 │ 4.2     │ 4.3      │ 4.4      │ 4.5
           │ API  │ Debug   │ Aliases   │ Analytics│ Routing
           │      │ API     │ CRUD     │          │ Scores
           │      │         │          │          │
           │ 4.6  │ 4.7     │
           │ UI   │ Search  │
           └──────┴─────────┘
                │
Phase 5:  Task 5.1 (auto-sync groups) + Task 5.2 (custom model groups)
                │
Phase 6:  Tasks 6.1–6.5 (tests + cleanup)
```

---

## Parallelization Opportunities

| Group | Tasks | Rationale |
|-------|-------|-----------|
| A | 1.2 + 1.3 | Different functions in same new file, no mutual deps |
| B | 2.1 + 2.2 + 2.3 + 2.5 | Different sources, different files, parallel after 1.1 |
| C | 3.1 + 3.2 | Chain builder and scoring, different concerns |
| D | 4.1 + 4.2 + 4.3 + 4.4 + 4.5 | Different API endpoints |
| E | 4.6 + 4.7 | Different client components |
| F | 5.1 + 5.2 | Auto-sync and custom model creation |
| G | 6.1 + 6.2 + 6.3 + 6.4 | Different test domains, can write in parallel |

---

## Estimated Effort

| Phase | Tasks | Estimated Complexity |
|-------|-------|---------------------|
| Phase 1 (Schema) | 4 | Medium — migration + new module |
| Phase 2 (Benchmarks) | 5 | Medium — refactoring existing pipeline |
| Phase 3 (Routing) | 4 | **High** — core routing logic changes |
| Phase 4 (API + UI) | 7 | Medium — many endpoints, careful shape design |
| Phase 5 (Auto-sync) | 2 | Low — extension of existing flow |
| Phase 6 (Tests) | 5 | Medium — new + existing test updates |
| **Total** | **27** | |
