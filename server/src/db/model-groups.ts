import type Database from 'better-sqlite3';
import { canonicalizeModelId, backfillCanonicalKeys } from './benchmark-scores.js';

// ─── ALIAS CACHE ────────────────────────────────────────────────────────
// In-memory cache of alias → group_key mappings. Invalidated when aliases
// change (e.g. after reconciliation or user edits).

let aliasCache: Map<string, string> | null = null;

export const DEFAULT_MODEL_GROUP_ALIASES: Array<{ alias: string; groupKey: string }> = [
  { alias: 'deepseek-v4-flash-free', groupKey: 'deepseek-v4-flash' },
  { alias: 'minimax-m3-free', groupKey: 'minimaxai/minimax-m3' },
  { alias: 'nemotron-3-ultra-free', groupKey: 'nvidia/nemotron-3-ultra-550b-a55b' },
  { alias: 'nvidia/nemotron-3-ultra-550b-a55b:free', groupKey: 'nvidia/nemotron-3-ultra-550b-a55b' },
];

export const DEFAULT_MODEL_GROUP_DISPLAY_NAMES: Array<{ groupKey: string; displayName: string }> = [
  { groupKey: 'minimaxai/minimax-m3', displayName: 'MiniMax M3' },
];

export function getAliasCache(db: Database.Database): Map<string, string> {
  if (!aliasCache) aliasCache = loadAliasCache(db);
  return aliasCache;
}

export function invalidateAliasCache(): void {
  aliasCache = null;
}

export function loadAliasCache(db: Database.Database): Map<string, string> {
  const rows = db.prepare('SELECT alias, group_key FROM model_group_aliases').all() as
    Array<{ alias: string; group_key: string }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.alias, row.group_key);
  }
  return map;
}

export function normalizeGroupAlias(alias: string): string {
  return canonicalizeModelId(alias.trim());
}

export function normalizeGroupKey(groupKey: string): string {
  return canonicalizeModelId(groupKey.trim());
}

export function seedDefaultModelGroupAliases(db: Database.Database): number {
  const insert = db.prepare('INSERT OR IGNORE INTO model_group_aliases (alias, group_key) VALUES (?, ?)');
  let inserted = 0;

  const tx = db.transaction(() => {
    for (const item of DEFAULT_MODEL_GROUP_ALIASES) {
      const result = insert.run(normalizeGroupAlias(item.alias), normalizeGroupKey(item.groupKey));
      inserted += result.changes;
    }
  });
  tx();

  return inserted;
}

export function applyDefaultModelGroupDisplayNames(db: Database.Database): number {
  const update = db.prepare(`
    UPDATE model_groups
       SET display_name = ?
     WHERE group_key = ?
       AND display_name != ?
  `);
  let changed = 0;

  const tx = db.transaction(() => {
    for (const item of DEFAULT_MODEL_GROUP_DISPLAY_NAMES) {
      const displayName = item.displayName.trim();
      const groupKey = normalizeGroupKey(item.groupKey);
      changed += update.run(displayName, groupKey, displayName).changes;
    }
  });
  tx();

  return changed;
}

export function syncFallbackConfigGroupIds(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE fallback_config
         SET group_id = NULL
       WHERE group_id IS NOT NULL
         AND id NOT IN (
           SELECT f.id
             FROM fallback_config f
             JOIN models m ON m.id = f.model_db_id
            WHERE m.group_id IS NOT NULL
              AND f.group_id = m.group_id
              AND f.id = (
                SELECT f2.id
                  FROM fallback_config f2
                  JOIN models m2 ON m2.id = f2.model_db_id
                 WHERE m2.group_id = m.group_id
                 ORDER BY f2.priority ASC, f2.id ASC
                 LIMIT 1
              )
         )
    `).run();

    db.prepare(`
      UPDATE fallback_config
         SET group_id = (
           SELECT m.group_id
             FROM models m
            WHERE m.id = fallback_config.model_db_id
         )
       WHERE id IN (
         SELECT f.id
           FROM fallback_config f
           JOIN models m ON m.id = f.model_db_id
          WHERE m.group_id IS NOT NULL
            AND f.id = (
              SELECT f2.id
                FROM fallback_config f2
                JOIN models m2 ON m2.id = f2.model_db_id
               WHERE m2.group_id = m.group_id
               ORDER BY f2.priority ASC, f2.id ASC
               LIMIT 1
            )
       )
    `).run();
  });
  tx();
}

// ─── GROUP KEY RESOLUTION ────────────────────────────────────────────────
// Per spec D4: normalize the model ID, then check the alias cache. If the
// normalized form matches an alias, return the alias target; otherwise the
// normalized form IS the group_key.

export function resolveGroupKey(modelId: string, aliasCache: Map<string, string>): string {
  const normalized = canonicalizeModelId(modelId);
  const aliasTarget = aliasCache.get(normalized);
  return aliasTarget ?? normalized;
}

// ─── GROUP PROPERTY PROPAGATION ───────────────────────────────────────────
// Writes group-level properties (display_name, benchmark_score, etc.) from
// the model_groups row down to every member model row.

export function propagateGroupProperties(db: Database.Database, groupId: number): void {
  const group = db.prepare('SELECT * FROM model_groups WHERE id = ?').get(groupId) as any;
  if (!group) return;
  const result = db.prepare(`
    UPDATE models SET
      display_name = ?,
      benchmark_score = ?,
      intelligence_rank = ?,
      size_label = ?,
      context_window = ?,
      max_output_tokens = ?,
      supports_vision = ?,
      supports_tools = ?
    WHERE group_id = ?
  `).run(
    group.display_name,
    group.benchmark_score,
    group.intelligence_rank,
    group.size_label,
    group.context_window,
    group.max_output_tokens,
    group.supports_vision,
    group.supports_tools,
    groupId,
  );
  console.log(`[ModelGroups] Propagated group ${group.group_key} (id=${groupId}) to ${result.changes} model rows`);
}

export function propagateAllGroupProperties(db: Database.Database): void {
  const groups = db.prepare('SELECT id FROM model_groups').all() as Array<{ id: number }>;
  for (const g of groups) {
    propagateGroupProperties(db, g.id);
  }
}

// ─── GROUP RECONCILIATION ────────────────────────────────────────────────
// Reconcile models → groups: create missing groups, reassign stale group_ids,
// merge properties per D12 (MAX for context_window/max_output_tokens,
// OR for supports_vision/supports_tools, first-created display_name).

export function reconcileGroups(db: Database.Database): { groupsCreated: number; modelsReassigned: number } {
  const cache = getAliasCache(db);

  const models = db.prepare('SELECT id, model_id, group_id FROM models').all() as
    Array<{ id: number; model_id: string; group_id: number | null }>;

  const findGroupByKey = db.prepare('SELECT id FROM model_groups WHERE group_key = ?');
  const insertGroup = db.prepare(`
    INSERT INTO model_groups (group_key, display_name, benchmark_score, intelligence_rank, size_label, context_window, max_output_tokens, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const setModelGroupId = db.prepare('UPDATE models SET group_id = ? WHERE id = ?');

  let groupsCreated = 0;
  let modelsReassigned = 0;
  const affectedGroupIds = new Set<number>();

  const tx = db.transaction(() => {
    for (const model of models) {
      const groupKey = resolveGroupKey(model.model_id, cache);

      // Check if the model's current group_id is correct
      let targetGroupId: number | null = null;
      const existingGroup = findGroupByKey.get(groupKey) as { id: number } | undefined;

      if (existingGroup) {
        targetGroupId = existingGroup.id;
      } else {
        // Create a new group from this model's properties
        const modelRow = db.prepare(
          'SELECT display_name, benchmark_score, intelligence_rank, size_label, context_window, max_output_tokens, supports_vision, supports_tools FROM models WHERE id = ?'
        ).get(model.id) as any;
        if (!modelRow) continue;

        const info = insertGroup.run(
          groupKey,
          modelRow.display_name,
          modelRow.benchmark_score,
          modelRow.intelligence_rank,
          modelRow.size_label,
          modelRow.context_window,
          modelRow.max_output_tokens,
          modelRow.supports_vision,
          modelRow.supports_tools,
        );
        targetGroupId = info.lastInsertRowid as number;
        groupsCreated++;
      }

      // Reassign if group_id is wrong or missing, or if current group has a different group_key
      let needsReassign = false;
      if (model.group_id === null) {
        needsReassign = true;
      } else {
        const currentGroup = db.prepare('SELECT group_key FROM model_groups WHERE id = ?').get(model.group_id) as { group_key: string } | undefined;
        if (!currentGroup || currentGroup.group_key !== groupKey) {
          needsReassign = true;
        }
      }

      if (needsReassign && targetGroupId !== null) {
        setModelGroupId.run(targetGroupId, model.id);
        modelsReassigned++;
        affectedGroupIds.add(targetGroupId);
      }
    }

    // Merge properties for groups that got new members
    for (const groupId of affectedGroupIds) {
      mergeGroupProperties(db, groupId);
      propagateGroupProperties(db, groupId);
    }
  });

  tx();

  if (groupsCreated > 0 || modelsReassigned > 0) {
    console.log(`[ModelGroups] Reconcile: ${groupsCreated} groups created, ${modelsReassigned} models reassigned`);
  }

  return { groupsCreated, modelsReassigned };
}

// ─── PROPERTY MERGE (D12) ────────────────────────────────────────────────
// For a group: take MAX of context_window and max_output_tokens across members,
// OR of supports_vision and supports_tools, and the first-created display_name.

function mergeGroupProperties(db: Database.Database, groupId: number): void {
  const group = db.prepare('SELECT group_key FROM model_groups WHERE id = ?').get(groupId) as { group_key: string } | undefined;
  if (!group) return;

  const members = db.prepare(`
    SELECT display_name, benchmark_score, intelligence_rank, size_label,
           context_window, max_output_tokens, supports_vision, supports_tools, id
    FROM models
    WHERE group_id = ?
    ORDER BY id ASC
  `).all(groupId) as any[];

  if (members.length === 0) return;

  // First-created display_name = from the model with smallest id (ORDER BY id ASC)
  const displayName = members[0].display_name;
  const benchmarkScore = members.reduce((best: any, m: any) =>
    (m.benchmark_score ?? -1) > (best.benchmark_score ?? -1) ? m : best, members[0]).benchmark_score;
  const intelligenceRank = members.reduce((best: any, m: any) =>
    (m.intelligence_rank ?? 0) > (best.intelligence_rank ?? 0) ? m : best, members[0]).intelligence_rank;
  const sizeLabel = members[0].size_label;
  const contextWindow = members.reduce((max: number | null, m: any) => {
    if (m.context_window == null) return max;
    return max == null ? m.context_window : Math.max(max, m.context_window);
  }, null as number | null);
  const maxOutputTokens = members.reduce((max: number | null, m: any) => {
    if (m.max_output_tokens == null) return max;
    return max == null ? m.max_output_tokens : Math.max(max, m.max_output_tokens);
  }, null as number | null);
  const supportsVision = members.some((m: any) => m.supports_vision) ? 1 : 0;
  const supportsTools = members.some((m: any) => m.supports_tools) ? 1 : 0;

  db.prepare(`
    UPDATE model_groups SET
      display_name = ?,
      benchmark_score = ?,
      intelligence_rank = ?,
      size_label = ?,
      context_window = ?,
      max_output_tokens = ?,
      supports_vision = ?,
      supports_tools = ?
    WHERE id = ?
  `).run(displayName, benchmarkScore, intelligenceRank, sizeLabel, contextWindow, maxOutputTokens, supportsVision, supportsTools, groupId);
}

// ─── ENSURE MODEL IN GROUP ────────────────────────────────────────────────
// Ensures the given model row is assigned to a group. Creates the group if
// needed. Returns the group_id.

export function ensureModelInGroup(db: Database.Database, modelId: number): number {
  const cache = getAliasCache(db);
  const model = db.prepare('SELECT id, model_id, group_id FROM models WHERE id = ?').get(modelId) as
    { id: number; model_id: string; group_id: number | null } | undefined;
  if (!model) throw new Error(`[ModelGroups] Model id=${modelId} not found`);

  const groupKey = resolveGroupKey(model.model_id, cache);

  // Already in the correct group?
  if (model.group_id !== null) {
    const currentGroup = db.prepare('SELECT group_key FROM model_groups WHERE id = ?').get(model.group_id) as
      { group_key: string } | undefined;
    if (currentGroup && currentGroup.group_key === groupKey) {
      return model.group_id;
    }
  }

  // Find or create the group
  const existingGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get(groupKey) as
    { id: number } | undefined;

  let groupId: number;
  if (existingGroup) {
    groupId = existingGroup.id;
  } else {
    const modelRow = db.prepare(
      'SELECT display_name, benchmark_score, intelligence_rank, size_label, context_window, max_output_tokens, supports_vision, supports_tools FROM models WHERE id = ?'
    ).get(model.id) as any;

    const info = db.prepare(`
      INSERT INTO model_groups (group_key, display_name, benchmark_score, intelligence_rank, size_label, context_window, max_output_tokens, supports_vision, supports_tools)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      groupKey,
      modelRow.display_name,
      modelRow.benchmark_score,
      modelRow.intelligence_rank,
      modelRow.size_label,
      modelRow.context_window,
      modelRow.max_output_tokens,
      modelRow.supports_vision,
      modelRow.supports_tools,
    );
    groupId = info.lastInsertRowid as number;
  }

  // Assign the model to the group
  db.prepare('UPDATE models SET group_id = ? WHERE id = ?').run(groupId, model.id);

  return groupId;
}
