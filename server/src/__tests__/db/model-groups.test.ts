import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  resolveGroupKey,
  getAliasCache,
  loadAliasCache,
  invalidateAliasCache,
  propagateGroupProperties,
  propagateAllGroupProperties,
  reconcileGroups,
  ensureModelInGroup,
  seedDefaultModelGroupAliases,
  applyDefaultModelGroupDisplayNames,
} from '../../db/model-groups.js';
import { initDb, getDb, setSetting } from '../../db/index.js';

// ─── resolveGroupKey ────────────────────────────────────────────────────
describe('resolveGroupKey', () => {
  it('normalizes model ID and returns it as group_key when no alias matches', () => {
    const cache = new Map<string, string>();
    // canonicalizeModelId lowercases, strips provider/ prefix, normalizes
    // separators, strips -instruct/-chat/-it/-hf, normalizes version dots
    expect(resolveGroupKey('openai/gpt-4o', cache)).toBe('gpt-4o');
    expect(resolveGroupKey('GPT-4o', cache)).toBe('gpt-4o');
    expect(resolveGroupKey('meta-llama/llama-3.3-70b-instruct', cache)).toBe('llama-3-3-70b');
  });

  it('returns the alias target group_key when the normalized ID matches an alias', () => {
    const cache = new Map<string, string>([
      ['deepseek-v4-flash-free', 'deepseek-v4-flash'],
    ]);
    expect(resolveGroupKey('deepseek-v4-flash-free', cache)).toBe('deepseek-v4-flash');
  });

  it('chains aliases: normalized ID maps to alias target which may itself be a group_key', () => {
    // If alias A → B and B is NOT itself an alias, resolveGroupKey returns B.
    // resolveGroupKey makes a single lookup, not recursive.
    const cache = new Map<string, string>([
      ['gpt-4o-2024-11-20', 'gpt-4o'],
    ]);
    // "gpt-4o-2024-11-20" canonicalizes to "gpt-4o-2024-11-20" (dots → dashes)
    // then hits the alias cache → "gpt-4o"
    expect(resolveGroupKey('gpt-4o-2024-11-20', cache)).toBe('gpt-4o');
  });

  it('returns the normalized form when alias cache is empty', () => {
    const cache = new Map<string, string>();
    expect(resolveGroupKey('openai/gpt-4o-mini', cache)).toBe('gpt-4o-mini');
  });
});

// ─── Alias cache ────────────────────────────────────────────────────────
describe('alias cache', () => {
  let db: Database.Database;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    db = initDb(':memory:');
    invalidateAliasCache();
  });

  it('loadAliasCache reads from the DB and returns a Map', () => {
    // Insert an alias directly
    db.prepare('INSERT OR IGNORE INTO model_group_aliases (alias, group_key) VALUES (?, ?)')
      .run('test-alias', 'test-group');

    const cache = loadAliasCache(db);
    expect(cache).toBeInstanceOf(Map);
    expect(cache.get('test-alias')).toBe('test-group');
  });

  it('loadAliasCache returns empty Map when no aliases exist', () => {
    db.prepare('DELETE FROM model_group_aliases').run();
    const cache = loadAliasCache(db);
    expect(cache.size).toBe(0);
  });

  it('invalidateAliasCache clears the cache, next getAliasCache reloads from DB', () => {
    db.prepare('INSERT OR IGNORE INTO model_group_aliases (alias, group_key) VALUES (?, ?)')
      .run('cache-test-alias', 'cache-test-group');

    // First load primes the cache
    const cache1 = getAliasCache(db);
    expect(cache1.get('cache-test-alias')).toBe('cache-test-group');

    // Add a NEW alias after the cache was primed
    db.prepare('INSERT OR IGNORE INTO model_group_aliases (alias, group_key) VALUES (?, ?)')
      .run('late-alias', 'late-group');

    // Without invalidation, the old cache is returned — new alias missing
    const cache2 = getAliasCache(db);
    expect(cache2.get('late-alias')).toBeUndefined();

    // Invalidate and reload — now the new alias appears
    invalidateAliasCache();
    const cache3 = getAliasCache(db);
    expect(cache3.get('late-alias')).toBe('late-group');
  });

  it('seeds default aliases for OpenCode Zen provider variants', () => {
    db.prepare('DELETE FROM model_group_aliases').run();

    const inserted = seedDefaultModelGroupAliases(db);
    const cache = loadAliasCache(db);

    expect(inserted).toBeGreaterThanOrEqual(4);
    expect(cache.get('deepseek-v4-flash-free')).toBe('deepseek-v4-flash');
    expect(cache.get('minimax-m3-free')).toBe('minimax-m3');
    expect(cache.get('nemotron-3-ultra-free')).toBe('nemotron-3-ultra-550b-a55b');
    expect(cache.get('nemotron-3-ultra-550b-a55b:free')).toBe('nemotron-3-ultra-550b-a55b');
  });

  it('applies default display names for canonical grouped models', () => {
    db.prepare(`
      UPDATE model_groups
         SET display_name = 'MiniMax M3 Free (OpenCode Zen)'
       WHERE group_key = 'minimax-m3'
    `).run();

    const changed = applyDefaultModelGroupDisplayNames(db);
    const group = db.prepare('SELECT display_name FROM model_groups WHERE group_key = ?')
      .get('minimax-m3') as { display_name: string };

    expect(changed).toBeGreaterThanOrEqual(1);
    expect(group.display_name).toBe('MiniMax M3');
  });
});

// ─── reconcileGroups ────────────────────────────────────────────────────
describe('reconcileGroups', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    invalidateAliasCache();
    // Wipe seeded data so each test owns its models/groups
    const db = getDb();
    db.exec('DELETE FROM fallback_config; DELETE FROM models; DELETE FROM model_groups; DELETE FROM model_group_aliases;');
  });

  it('creates groups for models that do not have one', () => {
      const db = getDb();
      // Insert a model with no group_id
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run('openai', 'gpt-4o', 'GPT-4o', 90, 1, 1, 'Frontier');

    const result = reconcileGroups(db);
    expect(result.groupsCreated).toBe(1);
    expect(result.modelsReassigned).toBe(1);

    // The model should now have a group_id
    const row = db.prepare('SELECT group_id FROM models WHERE model_id = ?').get('gpt-4o') as { group_id: number | null };
    expect(row.group_id).not.toBeNull();

    // A group should exist
    const group = db.prepare('SELECT * FROM model_groups WHERE group_key = ?').get('gpt-4o') as any;
    expect(group).toBeDefined();
    expect(group.display_name).toBe('GPT-4o');
  });

  it('reassigns models with stale group_ids', () => {
      const db = getDb();
      // Create an initial group
      db.prepare(`
        INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
        VALUES (?, ?, ?, ?)
      `).run('wrong-group', 'Wrong Group', 5, 'Medium');

      const wrongGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('wrong-group') as { id: number };

      // Insert a model pointing at the wrong group
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, group_id, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run('openai', 'gpt-4o', 'GPT-4o', 90, 1, 1, 'Frontier', wrongGroup.id);

    const result = reconcileGroups(db);
    expect(result.modelsReassigned).toBe(1);

    // The model should now be in the correct group
    const row = db.prepare('SELECT group_id FROM models WHERE model_id = ?').get('gpt-4o') as { group_id: number };
    const correctGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('gpt-4o') as { id: number };
    expect(row.group_id).toBe(correctGroup.id);
  });

  it('skips models already in the correct group', () => {
      const db = getDb();
      // Create the correct group
      db.prepare(`
        INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
        VALUES (?, ?, ?, ?)
      `).run('gpt-4o', 'GPT-4o', 1, 'Frontier');

      const group = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('gpt-4o') as { id: number };

      // Insert a model already in the correct group
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, group_id, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run('openai', 'gpt-4o', 'GPT-4o', 90, 1, 1, 'Frontier', group.id);

    const result = reconcileGroups(db);
    expect(result.groupsCreated).toBe(0);
    expect(result.modelsReassigned).toBe(0);
  });

  it('resolves aliases when determining the correct group_key', () => {
      const db = getDb();
      // Set up an alias: deepseek-v4-flash-free → deepseek-v4-flash
      db.prepare('INSERT OR IGNORE INTO model_group_aliases (alias, group_key) VALUES (?, ?)')
        .run('deepseek-v4-flash-free', 'deepseek-v4-flash');
      invalidateAliasCache();

      // Create the target group
      db.prepare(`
        INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
        VALUES (?, ?, ?, ?)
      `).run('deepseek-v4-flash', 'DeepSeek V4 Flash', 2, 'Large');

      const targetGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?')
        .get('deepseek-v4-flash') as { id: number };

      // Insert a model whose canonical key is the alias
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run('openrouter', 'deepseek-v4-flash-free', 'DSV4F Free', 80, 2, 1, 'Large');

    const result = reconcileGroups(db);
    // The model should be assigned to the alias target group, not a new group
    const row = db.prepare('SELECT group_id FROM models WHERE model_id = ?')
      .get('deepseek-v4-flash-free') as { group_id: number };
    expect(row.group_id).toBe(targetGroup.id);
  });
});

// ─── ensureModelInGroup ─────────────────────────────────────────────────
describe('ensureModelInGroup', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    invalidateAliasCache();
    const db = getDb();
    db.exec('DELETE FROM fallback_config; DELETE FROM models; DELETE FROM model_groups; DELETE FROM model_group_aliases;');
  });

  it('creates a new group when none exists for the model resolved key', () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run('openai', 'gpt-4o', 'GPT-4o', 90, 1, 1, 'Frontier');

    const model = db.prepare('SELECT id FROM models WHERE model_id = ?').get('gpt-4o') as { id: number };
    const groupId = ensureModelInGroup(db, model.id);

    expect(groupId).toBeGreaterThan(0);
    const group = db.prepare('SELECT * FROM model_groups WHERE id = ?').get(groupId) as any;
    expect(group.group_key).toBe('gpt-4o');
    expect(group.display_name).toBe('GPT-4o');
  });

  it('reuses an existing group when one matches the resolved key', () => {
      const db = getDb();
      // Pre-create the group
      db.prepare(`
        INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
        VALUES (?, ?, ?, ?)
      `).run('gpt-4o', 'GPT-4o', 1, 'Frontier');
      const existingGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('gpt-4o') as { id: number };

      // Insert two models with same canonical key
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run('openai', 'gpt-4o', 'GPT-4o', 90, 1, 1, 'Frontier');
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run('nim', 'nim/gpt-4o', 'GPT-4o NIM', 88, 1, 1, 'Frontier');

    const model1 = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get('openai', 'gpt-4o') as { id: number };
    const model2 = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get('nim', 'nim/gpt-4o') as { id: number };

    const g1 = ensureModelInGroup(db, model1.id);
    const g2 = ensureModelInGroup(db, model2.id);

    expect(g1).toBe(existingGroup.id);
    expect(g2).toBe(existingGroup.id);
  });

  it('returns the group_id', () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run('google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 85, 2, 1, 'Large');

    const model = db.prepare('SELECT id FROM models WHERE model_id = ?').get('gemini-2.5-pro') as { id: number };
    const groupId = ensureModelInGroup(db, model.id);

    const row = db.prepare('SELECT group_id FROM models WHERE id = ?').get(model.id) as { group_id: number };
    expect(row.group_id).toBe(groupId);
  });

  it('throws if model does not exist', () => {
    const db = getDb();
    expect(() => ensureModelInGroup(db, 99999)).toThrow(/not found/i);
  });
});

// ─── propagateGroupProperties ───────────────────────────────────────────
describe('propagateGroupProperties', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    invalidateAliasCache();
    const db = getDb();
    db.exec('DELETE FROM fallback_config; DELETE FROM models; DELETE FROM model_groups; DELETE FROM model_group_aliases;');
  });

  it('writes group properties to all member model rows', () => {
    const db = getDb();

    // Create a group
    db.prepare(`
      INSERT INTO model_groups (group_key, display_name, benchmark_score, intelligence_rank, size_label,
        context_window, max_output_tokens, supports_vision, supports_tools)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('gpt-4o', 'GPT-4o Group', 95, 1, 'Frontier', 128000, 16384, 1, 1);

    const group = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('gpt-4o') as { id: number };

    // Insert two models with different properties, both in this group
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label,
        context_window, max_output_tokens, supports_vision, supports_tools, group_id, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run('openai', 'gpt-4o', 'GPT-4o Old Name', 80, 2, 1, 'Medium', 64000, 4096, 0, 0, group.id);
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label,
        context_window, max_output_tokens, supports_vision, supports_tools, group_id, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run('nim', 'nim/gpt-4o', 'GPT-4o NIM Old', 70, 3, 1, 'Small', 32000, 2048, 0, 0, group.id);

    propagateGroupProperties(db, group.id);

    // Both models should now have the group's properties
    const models = db.prepare('SELECT * FROM models WHERE group_id = ?').all(group.id) as any[];
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(m.display_name).toBe('GPT-4o Group');
      expect(m.benchmark_score).toBe(95);
      expect(m.intelligence_rank).toBe(1);
      expect(m.size_label).toBe('Frontier');
      expect(m.context_window).toBe(128000);
      expect(m.max_output_tokens).toBe(16384);
      expect(m.supports_vision).toBe(1);
      expect(m.supports_tools).toBe(1);
    }
  });

  it('does nothing for a non-existent group id', () => {
    const db = getDb();
    // Should not throw
    expect(() => propagateGroupProperties(db, 99999)).not.toThrow();
  });
});

describe('propagateAllGroupProperties', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    invalidateAliasCache();
    const db = getDb();
    db.exec('DELETE FROM fallback_config; DELETE FROM models; DELETE FROM model_groups; DELETE FROM model_group_aliases;');
  });

  it('propagates properties for every group', () => {
    const db = getDb();

    // Create two groups
    db.prepare(`
      INSERT INTO model_groups (group_key, display_name, benchmark_score, intelligence_rank, size_label, supports_vision, supports_tools)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('group-a', 'Group A', 80, 1, 'Frontier', 1, 1);
    db.prepare(`
      INSERT INTO model_groups (group_key, display_name, benchmark_score, intelligence_rank, size_label, supports_vision, supports_tools)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('group-b', 'Group B', 50, 3, 'Medium', 0, 0);

    const groupA = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('group-a') as { id: number };
    const groupB = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('group-b') as { id: number };

    // Insert models with stale properties
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, group_id, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run('p1', 'a', 'Stale A', 0, 99, 1, 'Wrong', groupA.id);
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, group_id, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run('p2', 'b', 'Stale B', 0, 99, 1, 'Wrong', groupB.id);

    propagateAllGroupProperties(db);

    const modelA = db.prepare('SELECT * FROM models WHERE model_id = ?').get('a') as any;
    expect(modelA.display_name).toBe('Group A');
    expect(modelA.benchmark_score).toBe(80);

    const modelB = db.prepare('SELECT * FROM models WHERE model_id = ?').get('b') as any;
    expect(modelB.display_name).toBe('Group B');
    expect(modelB.benchmark_score).toBe(50);
  });
});
