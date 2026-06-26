# Requirements — Model Grouping

---

## R1: Model Group Identity

**R1.1** A new `model_groups` table stores the canonical identity of each model, independent of provider:

```sql
CREATE TABLE IF NOT EXISTS model_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key TEXT NOT NULL UNIQUE,        -- normalized model identity (e.g. "deepseek-v4-flash")
  display_name TEXT NOT NULL,            -- canonical display name ("DeepSeek V4 Flash")
  benchmark_score REAL,                 -- shared intelligence score from benchmark pipeline
  size_label TEXT NOT NULL DEFAULT '',   -- Frontier / Large / Medium / Small
  intelligence_rank INTEGER,            -- derived from benchmark_score (shared across providers)
  context_window INTEGER,              -- shared capability
  max_output_tokens INTEGER,           -- shared capability
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,  -- group-level enable/disable
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**R1.2** Each `models` row gains a `group_id INTEGER REFERENCES model_groups(id)` column. Multiple model rows can reference the same group.

**R1.3** The `model_groups.group_key` is derived from `canonical_model_key` (the existing normalization function in `benchmark-scores.ts`) but can be overridden via the alias table (R2).

**R1.4** When no `model_groups` row exists for a given `group_key`, one is created automatically during model insertion/migration with properties propagated from the first model row that creates the group. Subsequent models joining the group inherit group-level properties from the group, **not** from their own per-row values.

**R1.5** `group_key` uniqueness is enforced by the `UNIQUE` constraint on `model_groups.group_key`. Two groups with the same `group_key` cannot exist.

---

## R2: Model Group Alias Mapping

**R2.1** A new `model_group_aliases` table provides explicit mapping from variant model IDs to group keys:

```sql
CREATE TABLE IF NOT EXISTS model_group_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,              -- variant name ("deepseek-v4-flash-free", "gpt-4o-2024-11-20")
  group_key TEXT NOT NULL,          -- target group ("deepseek-v4-flash", "gpt-4o")
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(alias)
);
```

**R2.2** When resolving a model's group, the system checks `model_group_aliases` first (exact match on the normalized alias form), then falls back to `canonicalizeModelId(model_id)` as the group key.

**R2.3** Both the alias and the group_key are stored in normalized (lowercase, separator-collapsed) form. The lookup function normalizes the input before querying.

**R2.4** The alias table is seeded during migration with known multi-provider variants. The initial seed includes (but is not limited to):

| Alias | Group Key | Rationale |
|-------|-----------|-----------|
| `deepseek-v4-flash-free` | `deepseek-v4-flash` | Same model, free-tier access |
| `deepseek-v4-pro-free` | `deepseek-v4-pro` | Same model, free-tier access |
| `gpt-4o-2024-11-20` | `gpt-4o` | Date-snapshot of same model |
| `gpt-4o-mini-2024-07-18` | `gpt-4o-mini` | Date-snapshot of same model |
| `gemini-2.5-flash-preview-05-20` | `gemini-2.5-flash` | Preview snapshot |
| `qwen3-30b-a3b` | `qwen3-30b` | MoE variant naming |

**R2.5** The alias table can be modified via the admin API at runtime — operators can add, remove, or change alias mappings without a code deployment.

**R2.6** When a new alias is added that would cause an existing model to re-group (its `group_id` assignment changes), a background reconciliation re-assigns the model and re-derives group properties — see R3.5.

---

## R3: Group-Level vs. Provider-Level Property Split

**R3.1** The following properties are **group-level** (stored on `model_groups`, shared across all providers of the same model):

| Property | Rationale |
|----------|-----------|
| `display_name` | The model's canonical name — doesn't depend on provider |
| `benchmark_score` | Intelligence is a property of the model, not the provider |
| `intelligence_rank` | Derived from benchmark_score |
| `size_label` | Model size class (Frontier/Large/Medium/Small) |
| `supports_vision` | Capability of the model |
| `supports_tools` | Capability of the model |
| `context_window` | Model's context limit |
| `max_output_tokens` | Model's output limit |
| `enabled` | Enable/disable the entire group |

**R3.2** The following properties are **provider-level** (stored on each `models` row, potentially different per provider):

| Property | Rationale |
|----------|-----------|
| `platform` | Which provider serves this model |
| `model_id` | Provider-specific model identifier string |
| `rpm_limit`, `rpd_limit`, `tpm_limit`, `tpd_limit` | Provider-specific rate limits |
| `monthly_token_budget` | Per-provider budget |
| `key_id` | Binds custom model to a specific key/endpoint |
| `speed_rank` | Speed can differ across providers |
| `enabled` (model-row level) | Disable one provider's instance without disabling the group |

**R3.3** Group-level properties are **authoritative**: when a group exists, the `models` row's version of those columns (e.g. `models.intelligence_rank`, `models.benchmark_score`) becomes a **denormalized cache** populated from the group. The group is the source of truth. After grouping is active, writes to `models.benchmark_score` are replaced by writes to `model_groups.benchmark_score` + propagation to member rows.

**R3.4** When the `model_groups` row is first created (during migration), its properties are taken from the **highest-benchmarked** model row in the group (the one with the highest `benchmark_score`, or if tied, the smallest `id`). This ensures the group starts with the best-known metadata.

**R3.5** **Property reconciliation.** When a provider's auto-sync reports different properties for the same model (e.g. a different `context_window`), the group property takes the **maximum** value across all providers (a larger context window is the more capable assumption; if one provider reports 128k and another 64k, 128k is used as the group-level context). The exception is `supports_vision` and `supports_tools`, which use **logical OR** (if any provider offers it, the group offers it).

---

## R4: Benchmark Pipeline Integration

**R4.1** `fetchAAScores` writes `aa_score` to `model_groups` (via `group_key` matching), not to individual `models` rows. The per-model `aa_score` columns are still populated but as a cache propagated from the group composite.

**R4.2** `recomputeBenchmarkComposite` computes and writes `benchmark_score` to `model_groups`, then propagates to all member `models` rows.

**R4.3** A model that is the only member of its group (standalone model) still gets its benchmark score through the group — there is no "ungrouped" path. The group is the universal unit for benchmark scoring.

**R4.4** The `canonical_model_key` column on `models` is retained as-is (it's still useful for pattern matching in the static `BENCHMARK_SCORES` table). The group's `group_key` defaults to equal `canonical_model_key` but may differ when aliases override it.

---

## R5: Routing Integration

**R5.1** The fallback chain (`fallback_config`) references **group IDs**, not individual model DB IDs:

```sql
-- NEW:
fallback_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES model_groups(id),
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(group_id)
)

-- OLD (deprecated after migration):
-- fallback_config.model_db_id → models.id
```

**R5.2** The router's `routeRequest()` iterates over **groups** in priority order. For each group, it evaluates all enabled provider-entries within the group, scoring them on per-provider axes (speed, reliability, degradation, key availability). The provider with the highest per-provider score gets the request. If that provider fails (key exhausted, rate-limited, degradation too high), the router **retries within the same group** before moving to the next group.

**R5.3** Within a group, provider selection uses this sub-ranking order:
1. Exclude providers with no enabled/healthy keys
2. Exclude providers whose model-row is disabled
3. If the request pins a model, try the pinned group only (resolved from the group's `group_key`)
4. Score remaining providers on: `speed × latency × (1 − degradation)` — the intelligence axis is skipped because all providers in the group are equal on intelligence
5. If multiple providers tie, use round-robin within the group

**R5.4** The `scoreChainEntry()` function gains a `provider-level` scoring mode for within-group selection. This uses only speed, latency, reliability, and degradation axes (no intelligence). The existing full scoring (intelligence-inclusive) is used at the group level for chain ordering.

**R5.5** Group-level chain ordering uses the **best provider's** composite score as the group's representative score. This prevents a group from being penalized in chain position just because one of its providers is slow — the group's position in the chain reflects its best-available provider.

---

## R6: Degradation Integration

**R6.1** Degradation state remains **per-provider** (per `model_db_id`). A 503 on NV's DeepSeek V4 Flash does **not** penalize OpenCode Zen's DeepSeek V4 Flash.

**R6.2** On the dashboard, the group's displayed degradation state shows:
- The **worst** active penalty across providers (so the operator sees "something is degraded")
- Per-provider breakdown available on expand

**R6.3** When a provider within a group is fully degraded (penalty ≥ threshold where `degradation_factor < 0.1`), the router skips that provider and tries others in the same group before moving to the next group.

**R6.4** The degradation event stream (`publish()`) includes the `group_id` alongside `model_db_id` so dashboard consumers can filter/group events by model.

**R6.5** Degradation recovery (FR-4 from dynamic-degradation spec) operates per-provider as before — no group-level recovery logic.

---

## R7: Analytics Integration

**R7.1** The `GET /api/analytics/...` endpoints gain an optional `?groupBy=model` query parameter. When set, request stats, token usage, and latency metrics are aggregated **by model group** (summing across providers).

**R7.2** The default (backward-compatible) behavior continues to aggregate by `(platform, model_id)` — no existing analytics break.

**R7.3** In grouped mode, speed metrics (tokens/sec, TTFB) are averaged across all providers weighted by request count. The response includes a `providers[]` array with per-provider breakdowns for operators who need to drill down.

**R7.4** The `requests` table continues to store `(platform, model_id)` per-request — no schema change. Aggregation happens at query time via the model-to-group join.

---

## R8: Dashboard Integration

**R8.1** The `GET /api/models` endpoint returns **grouped** data by default. Each entry represents a model group:

```typescript
{
  groupId: 42,
  groupKey: "deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
  benchmarkScore: 55,
  intelligenceRank: 46,
  sizeLabel: "Frontier",
  contextWindow: 131072,
  supportsVision: true,
  supportsTools: true,
  enabled: true,
  providers: [
    {
      modelDbId: 101,
      platform: "nim",
      modelId: "nim/deepseek-v4-flash",
      speedRank: 8,
      rpmLimit: 30,
      keyCount: 2,
      enabled: true,
      degradation: { penalty: 0, tier: "healthy" },
    },
    {
      modelDbId: 207,
      platform: "opencode-zen",
      modelId: "opencode-zen/deepseek-v4-flash-free",
      speedRank: 6,
      rpmLimit: 10,
      keyCount: 1,
      enabled: true,
      degradation: { penalty: 3.5, tier: "minor" },
    }
  ],
  priority: 5,         // group's position in fallback chain
  fallbackEnabled: true,
}
```

**R8.2** A `?flat=true` query parameter on `GET /api/models` returns the current (ungrouped) flat response for backward compatibility and for features that need per-provider granularity.

**R8.3** The client's FallbackPage renders groups as expandable cards. The collapsed view shows group-level info + best degradation tier. Expanding reveals per-provider details.

**R8.4** The model search box (`model-search-box.tsx`) shows groups, not individual provider-models. Selecting a group for pinning resolves to the group's `group_key` in the request body.

---

## R9: Model Pinning Integration

**R9.1** When a client sends `model: "deepseek-v4-flash"` in the request body, the proxy resolves it to a **group**, not a specific `(platform, model_id)` pair. The router then selects the best provider within that group.

**R9.2** The resolver checks `model_group_aliases` first, then falls back to `canonicalizeModelId()`. If the resolved key matches a `model_groups.group_key`, the request is pinned to that group.

**R9.3** If the user explicitly wants a specific provider's model (advanced use), they can still use the `provider/model` syntax: `model: "nim/deepseek-v4-flash"`. This bypasses the group resolver and routes to the exact model.

**R9.4** When pin mode is active and the group has no healthy providers (all degraded / no keys), the existing `PINNED_MODEL_EXHAUSTED` error is raised — same as today, but scoped to the group.

---

## R10: Auto-Sync & Custom Provider Integration

**R10.1** When `syncModelsFromProvider()` discovers a new model from a custom provider, it runs the model through the group resolver: normalize the model_id → check alias table → compute group_key → find or create the `model_groups` row → assign `group_id`.

**R10.2** If the new model maps to an existing group, the provider's model row joins the group. Group-level properties are NOT overwritten by the new provider's auto-synced values (the group is authoritative).

**R10.3** If the new model is genuinely unique (no existing group matches), a new `model_groups` row is created with properties from the auto-synced model row.

**R10.4** Custom providers' models that don't match any known model pattern create standalone groups (groups with a single provider). This has zero functional overhead compared to the current system.

---

## R11: Migration Strategy

**R11.1** A new migration version creates the `model_groups` and `model_group_aliases` tables, adds the `group_id` column to `models`, and populates both from existing data.

**R11.2** The migration algorithm:
1. For each distinct `canonical_model_key` in `models`, create a `model_groups` row
2. Seed `model_group_aliases` from the hard-coded alias table (R2.4)
3. Re-run group resolution for models whose alias maps them to a different group
4. Populate `fallback_config` with group IDs (each unique group gets one entry, priority derived from the best-priority model in the group)
5. Backfill `group_id` on all `models` rows

**R11.3** Rollback is documented: drop `model_group_aliases`, drop `group_id` from `models`, drop `model_groups`, recreate `fallback_config` from original `model_db_id` values.

**R11.4** The migration must be idempotent — running it twice produces the same result.

---

## R12: Backward Compatibility

**R12.1** The `GET /api/models?flat=true` response shape is identical to today's response. Existing dashboard consumers are not broken.

**R12.2** The proxy endpoint (`POST /v1/chat/completions`) continues to accept `model` in both group-key form (`"deepseek-v4-flash"`) and explicit-provider form (`"nim/deepseek-v4-flash"`). Existing client code works without changes.

**R12.3** The `models` table retains all existing columns. `intelligence_rank`, `benchmark_score`, etc. become denormalized caches populated from `model_groups`, but they remain readable by existing code paths that haven't been migrated yet. This allows incremental migration.

**R12.4** The `fallback_config` table gains a `group_id` column alongside the existing `model_db_id`. During the transition, both columns are populated. The router uses `group_id` when the grouping feature is enabled; falls back to `model_db_id` when not. A feature flag (`model_grouping_enabled`) gates the new routing path.

**R12.5** Existing tests pass without modification (or with semantically-equivalent updates to the new schema).

---

## R13: Observability

**R13.1** Every group resolution event (model matched to group, new group created, alias applied) emits a structured log entry at `info` level.

**R13.2** The routing decision log includes the group ID and the selected provider within the group.

**R13.3** The `GET /api/fallback/routing` endpoint returns grouped scores — each group shows its composite score plus per-provider sub-scores.

**R13.4** A `GET /api/models/groups` endpoint returns the group map (all groups with member providers), useful for debugging alias resolution.

---

## Non-Goals

- ❌ Merging properties when providers disagree on model capabilities (always take max/or — see R3.5)
- ❌ Cross-provider degradation propagation (NV failing ≠ Zen failing)
- ❌ Dashboard drag-and-drop for per-provider ordering within groups (sub-ranking is automatic)
- ❌ Changing the bandit scoring weight presets (balanced/smartest/fastest/reliable)
- ❌ Removing the flat models API (it remains available via `?flat=true`)
- ❌ Grouping models with genuinely different capabilities (e.g. `gpt-4o` and `gpt-4o-mini` are different models even though they share a name prefix)
