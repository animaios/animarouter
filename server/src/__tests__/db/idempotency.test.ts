import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../../db/index.js';
import { scoreToIntelligenceRank } from '../../db/benchmark-scores.js';

/**
 * All migrations must be idempotent: running initDb twice on the same
 * physical database file should produce identical state.
 */
describe('Migration idempotency', () => {
  it('initDb on a fresh in-memory DB then re-run produces identical row counts', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    // Use a single shared file so both inits hit the same DB.
    const tmpPath = `/tmp/animarouter-idempotency-${Date.now()}.db`;

    const db1 = initDb(tmpPath);
    const before = {
      models: (db1.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
      fallback: (db1.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
      orphanFallbacks: (db1.prepare(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `).get() as { c: number }).c,
    };
    db1.close();

    // Re-init the same DB file — V1..V9 should all no-op idempotently.
    const db2 = initDb(tmpPath);
    const after = {
      models: (db2.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
      fallback: (db2.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
      orphanFallbacks: (db2.prepare(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `).get() as { c: number }).c,
    };
    db2.close();

    expect(after).toEqual(before);
    expect(after.orphanFallbacks).toBe(0);
  });

  it('every catalog row has exactly one fallback_config entry', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const rows = db.prepare(`
      SELECT m.id, COUNT(f.id) AS fb_count
        FROM models m
        LEFT JOIN fallback_config f ON m.id = f.model_db_id
       GROUP BY m.id
      HAVING COUNT(f.id) <> 1
    `).all() as { id: number; fb_count: number }[];

    expect(rows).toEqual([]);
  });

  it('V38 preserves fallback rows while normalizing one grouped fallback per group', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tmpPath = `/tmp/animarouter-v38-fallback-${suffix}.db`;

    const db = initDb(tmpPath);
    db.prepare('DROP INDEX IF EXISTS idx_fallback_config_group_id_unique').run();

    const insertGroup = db.prepare(`
      INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
      VALUES (?, ?, 1, 'Test')
    `);
    const insertModel = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         monthly_token_budget, enabled, group_id)
      VALUES (?, ?, ?, 1, 1, 'Test', '', 1, ?)
    `);
    const insertFallback = db.prepare(`
      INSERT INTO fallback_config (model_db_id, priority, group_id, enabled)
      VALUES (?, ?, ?, 1)
    `);

    const priorityGroupId = insertGroup.run(
      `v38-priority-${suffix}`,
      'V38 Priority',
    ).lastInsertRowid as number;
    const highPriorityModelId = insertModel.run(
      `v38-priority-a-${suffix}`,
      'model-a',
      'V38 Priority A',
      priorityGroupId,
    ).lastInsertRowid as number;
    const lowPriorityModelId = insertModel.run(
      `v38-priority-b-${suffix}`,
      'model-b',
      'V38 Priority B',
      priorityGroupId,
    ).lastInsertRowid as number;
    insertFallback.run(highPriorityModelId, 20, priorityGroupId);
    insertFallback.run(lowPriorityModelId, 10, priorityGroupId);

    const tieGroupId = insertGroup.run(
      `v38-tie-${suffix}`,
      'V38 Tie',
    ).lastInsertRowid as number;
    const firstTieModelId = insertModel.run(
      `v38-tie-a-${suffix}`,
      'model-a',
      'V38 Tie A',
      tieGroupId,
    ).lastInsertRowid as number;
    const secondTieModelId = insertModel.run(
      `v38-tie-b-${suffix}`,
      'model-b',
      'V38 Tie B',
      tieGroupId,
    ).lastInsertRowid as number;
    insertFallback.run(firstTieModelId, 7, tieGroupId);
    insertFallback.run(secondTieModelId, 7, tieGroupId);
    db.close();

    const db2 = initDb(tmpPath);

    const priorityRows = db2.prepare(`
      SELECT model_db_id, priority, group_id
        FROM fallback_config
       WHERE model_db_id IN (?, ?)
       ORDER BY model_db_id
    `).all(highPriorityModelId, lowPriorityModelId) as Array<{
      model_db_id: number;
      priority: number;
      group_id: number | null;
    }>;
    expect(priorityRows).toHaveLength(2);
    expect(priorityRows.filter(row => row.group_id === priorityGroupId)).toEqual([
      { model_db_id: lowPriorityModelId, priority: 10, group_id: priorityGroupId },
    ]);

    const tieRows = db2.prepare(`
      SELECT model_db_id, priority, group_id
        FROM fallback_config
       WHERE model_db_id IN (?, ?)
       ORDER BY model_db_id
    `).all(firstTieModelId, secondTieModelId) as Array<{
      model_db_id: number;
      priority: number;
      group_id: number | null;
    }>;
    expect(tieRows).toHaveLength(2);
    expect(tieRows.filter(row => row.group_id === tieGroupId)).toEqual([
      { model_db_id: firstTieModelId, priority: 7, group_id: tieGroupId },
    ]);

    const duplicateGroups = db2.prepare(`
      SELECT group_id, COUNT(*) AS c
        FROM fallback_config
       WHERE group_id IS NOT NULL
       GROUP BY group_id
      HAVING COUNT(*) > 1
    `).all();
    expect(duplicateGroups).toEqual([]);

    const indexRow = db2.prepare(`
      SELECT name
        FROM sqlite_master
       WHERE type = 'index'
         AND name = 'idx_fallback_config_group_id_unique'
    `).get();
    expect(indexRow).toBeTruthy();
    db2.close();
  });

  it('adds group_id columns before V38 runs on legacy schemas', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tmpPath = `/tmp/animarouter-v38-legacy-columns-${suffix}.db`;

    const db = initDb(tmpPath);
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP INDEX IF EXISTS idx_fallback_config_group_id_unique').run();
    db.prepare('DELETE FROM model_group_aliases').run();
    db.prepare('DELETE FROM model_groups').run();

    db.exec(`
      ALTER TABLE models DROP COLUMN supports_tools;
      ALTER TABLE models DROP COLUMN max_output_tokens;
      ALTER TABLE models DROP COLUMN group_id;
      ALTER TABLE fallback_config DROP COLUMN group_id;
      PRAGMA user_version = 4;
    `);
    db.close();

    const db2 = initDb(tmpPath);
    const upgradedModelColumns = (db2.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>)
      .map(col => col.name);
    const upgradedFallbackColumns = (db2.prepare('PRAGMA table_info(fallback_config)').all() as Array<{ name: string }>)
      .map(col => col.name);

    expect(upgradedModelColumns).toContain('group_id');
    expect(upgradedModelColumns).toContain('supports_tools');
    expect(upgradedModelColumns).toContain('max_output_tokens');
    expect(upgradedFallbackColumns).toContain('group_id');
    expect((db2.prepare('SELECT COUNT(*) AS c FROM model_groups').get() as { c: number }).c).toBeGreaterThan(0);
    expect((db2.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 1 AND group_id IS NULL').get() as { c: number }).c).toBe(0);
    db2.close();
  });

  it('UNIQUE(platform, model_id) constraint holds — no duplicate catalog rows', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const dups = db.prepare(`
      SELECT platform, model_id, COUNT(*) AS c FROM models
       GROUP BY platform, model_id
      HAVING COUNT(*) > 1
    `).all();

    expect(dups).toEqual([]);
  });

  it('V12: dead OR :free rows are absent and the four new rows are present', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const dead = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN ('inclusionai/ling-2.6-1t:free', 'tencent/hy3-preview:free')
    `).all();
    expect(dead).toEqual([]);

    // V21 pruned these three after live probing returned 404 "no endpoints found".
    const pruned = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN (
           'arcee-ai/trinity-large-thinking:free',
           'minimax/minimax-m2.5:free',
           'baidu/cobuddy:free'
         )
    `).all();
    expect(pruned).toEqual([]);

    const live = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN (
           'openrouter/owl-alpha',
           'nousresearch/hermes-3-llama-3.1-405b:free'
         )
       ORDER BY model_id
    `).all() as { model_id: string }[];
    expect(live.map(r => r.model_id)).toEqual([
      'nousresearch/hermes-3-llama-3.1-405b:free',
      'openrouter/owl-alpha',
    ]);

    const widened = db.prepare(`
      SELECT model_id, context_window FROM models
       WHERE platform = 'openrouter'
         AND model_id IN ('nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3-coder:free')
       ORDER BY model_id
    `).all() as { model_id: string; context_window: number }[];
    expect(widened).toEqual([
      { model_id: 'nvidia/nemotron-3-super-120b-a12b:free', context_window: 1000000 },
      { model_id: 'qwen/qwen3-coder:free', context_window: 1048576 },
    ]);
  });

  it('V13: cross-provider catalog refresh applies cleanly', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    // Disables — row kept but enabled=0.
    const disabled = db.prepare(`
      SELECT platform, model_id, enabled FROM models
       WHERE (platform = 'google' AND model_id = 'gemini-3.1-pro-preview')
          OR (platform = 'ollama' AND model_id IN ('kimi-k2-thinking', 'mistral-large-3:675b', 'deepseek-v3.2'))
       ORDER BY platform, model_id
    `).all() as { platform: string; model_id: string; enabled: number }[];
    expect(disabled).toHaveLength(4);
    for (const row of disabled) expect(row.enabled).toBe(0);

    // Hard removals — row is gone entirely.
    const removed = db.prepare(`
      SELECT model_id FROM models
       WHERE (platform = 'sambanova' AND model_id = 'DeepSeek-V3.1-cb')
          OR (platform = 'cloudflare' AND model_id = '@cf/moonshotai/kimi-k2.5')
    `).all();
    expect(removed).toEqual([]);

    // New rows present across providers (incl. new huggingface platform).
    const additions = db.prepare(`
      SELECT platform, model_id FROM models
       WHERE (platform, model_id) IN (VALUES
         ('groq',        'openai/gpt-oss-safeguard-20b'),
         ('cloudflare',  '@cf/nvidia/nemotron-3-120b-a12b'),
         ('cloudflare',  '@cf/google/gemma-4-26b-a4b-it'),
         ('google',      'gemini-3.5-flash'),
         ('nvidia',      'deepseek-ai/deepseek-v4-flash'),
         ('nvidia',      'z-ai/glm-5.1'),
         ('nvidia',      'qwen/qwen3-coder-480b-a35b-instruct'),
         ('mistral',     'mistral-small-latest'),
         ('mistral',     'ministral-8b-latest'),
         ('cohere',      'command-a-reasoning-08-2025'),
         ('cohere',      'command-r-08-2024'),
         ('ollama',      'qwen3-coder-next'),
         ('huggingface', 'deepseek-ai/DeepSeek-V4-Flash'),
         ('huggingface', 'moonshotai/Kimi-K2.6'),
         ('huggingface', 'Qwen/Qwen3-Coder-Next')
       )
    `).all();
    expect(additions).toHaveLength(15);

    // Spot-check critical limit/context updates.
    const cerebrasLimits = db.prepare(`
      SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM models
       WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'
    `).get() as { rpm_limit: number; rpd_limit: number; tpm_limit: number; tpd_limit: number };
    expect(cerebrasLimits).toEqual({ rpm_limit: 5, rpd_limit: 2400, tpm_limit: 30000, tpd_limit: 1000000 });

    const cfFp8Ctx = (db.prepare(`
      SELECT context_window FROM models WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    `).get() as { context_window: number }).context_window;
    expect(cfFp8Ctx).toBe(24000);

    const mistralCtx = db.prepare(`
      SELECT model_id, context_window FROM models
       WHERE platform = 'mistral'
         AND model_id IN ('codestral-latest', 'devstral-latest', 'magistral-medium-latest', 'mistral-large-latest')
       ORDER BY model_id
    `).all() as { model_id: string; context_window: number }[];
    expect(mistralCtx).toEqual([
      { model_id: 'codestral-latest',       context_window: 256000 },
      { model_id: 'devstral-latest',        context_window: 262144 },
      { model_id: 'magistral-medium-latest', context_window: 131072 },
      { model_id: 'mistral-large-latest',   context_window: 262144 },
    ]);
  });

  it('V14: cerebras deprecation disables qwen-3-235b and llama3.1-8b but keeps gpt-oss-120b enabled', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const rows = db.prepare(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'cerebras'
         AND model_id IN ('qwen-3-235b-a22b-instruct-2507', 'llama3.1-8b', 'gpt-oss-120b')
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number }[];

    expect(rows).toEqual([
      { model_id: 'gpt-oss-120b',                    enabled: 1 },
      { model_id: 'llama3.1-8b',                     enabled: 0 },
      { model_id: 'qwen-3-235b-a22b-instruct-2507',  enabled: 0 },
    ]);
  });

  it('V23: sambanova/chutes are gone; live-verified free additions are present with the right flags', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    // Platform drops — no model, fallback, or key rows survive.
    const deadRows = db.prepare(
      `SELECT COUNT(*) AS n FROM models WHERE platform IN ('sambanova', 'chutes')`
    ).get() as { n: number };
    expect(deadRows.n).toBe(0);
    const deadKeys = db.prepare(
      `SELECT COUNT(*) AS n FROM api_keys WHERE platform IN ('sambanova', 'chutes')`
    ).get() as { n: number };
    expect(deadKeys.n).toBe(0);

    // Additions, with the flags the live probe verified (vision/tools come
    // from the V16/V22 rules, so they must hold on a fresh seed too).
    const added = db.prepare(`
      SELECT platform, model_id, enabled, supports_vision, supports_tools FROM models
       WHERE (platform = 'openrouter' AND model_id IN (
               'moonshotai/kimi-k2.6:free',
               'nvidia/nemotron-3-ultra-550b-a55b:free',
               'nvidia/nemotron-nano-12b-v2-vl:free',
               'meta-llama/llama-3.2-3b-instruct:free',
               'cognitivecomputations/dolphin-mistral-24b-venice-edition:free'))
          OR (platform = 'zhipu' AND model_id = 'glm-4.6v-flash')
       ORDER BY platform, model_id
    `).all() as { model_id: string; enabled: number; supports_vision: number; supports_tools: number }[];
    expect(added.map(r => [r.model_id, r.enabled, r.supports_vision, r.supports_tools])).toEqual([
      ['cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 1, 0, 0],
      ['meta-llama/llama-3.2-3b-instruct:free',                         1, 0, 0],
      ['moonshotai/kimi-k2.6:free',                                     1, 0, 1],
      ['nvidia/nemotron-3-ultra-550b-a55b:free',                        0, 0, 1], // hangs 180s+; seeded disabled (tools verified via Zen in V24)
      ['nvidia/nemotron-nano-12b-v2-vl:free',                           1, 1, 1],
      ['glm-4.6v-flash',                                                1, 1, 1],
    ]);
  });

  it('V24: Zen roster refresh lands and the hung NIM gemma is paused', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const zen = db.prepare(`
      SELECT model_id, enabled, supports_tools FROM models
       WHERE platform = 'opencode' AND model_id IN ('nemotron-3-ultra-free', 'minimax-m3-free')
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number; supports_tools: number }[];
    expect(zen.map(r => [r.model_id, r.enabled, r.supports_tools])).toEqual([
      // minimax-m3-free was seeded enabled here in V24, then retired in V25 when
      // its free promo ended (now enabled=0). nemotron-3-ultra-free is still live.
      ['minimax-m3-free',       0, 1],
      ['nemotron-3-ultra-free', 1, 1],
    ]);

    // The hung NIM gemma route is paused (row kept, enabled=0, re-asserted
    // each boot like the V13 disables).
    const gemma = db.prepare(`
      SELECT enabled FROM models WHERE platform = 'nvidia' AND model_id = 'google/gemma-4-31b-it'
    `).get() as { enabled: number };
    expect(gemma.enabled).toBe(0);
  });

  it('groups OpenCode Zen MiniMax M3 Free under canonical MiniMax M3', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const alias = db.prepare(`
      SELECT group_key
        FROM model_group_aliases
       WHERE alias = 'minimax-m3-free'
    `).get() as { group_key: string };
    expect(alias.group_key).toBe('minimax-m3');

    const grouped = db.prepare(`
      SELECT g.group_key, g.display_name
        FROM models m
        JOIN model_groups g ON g.id = m.group_id
       WHERE m.platform = 'opencode'
         AND m.model_id = 'minimax-m3-free'
    `).get() as { group_key: string; display_name: string };

    expect(grouped).toEqual({
      group_key: 'minimax-m3',
      display_name: 'MiniMax M3',
    });
  });

  it('manual benchmark overrides pin the curated top-pool intelligence order', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const expected: Array<{ label: string; score: number; modelKeys: string[]; groupKeys: string[] }> = [
              { label: 'glm-5-1', score: 100, modelKeys: ['glm-5-1', 'glm-5-1-fp8'], groupKeys: ['glm-5-1', 'glm-5-1-fp8'] },
              { label: 'kimi-k2-6', score: 93, modelKeys: ['@cf/moonshotai/kimi-k2-6', 'kimi-k2-6', 'kimi-k2-6:free'], groupKeys: ['@cf/moonshotai/kimi-k2-6', 'kimi-k2-6', 'kimi-k2-6:free'] },
              { label: 'nemotron-3-ultra', score: 89, modelKeys: ['nemotron-3-ultra-550b-a55b:free', 'nemotron-3-ultra-free'], groupKeys: ['nemotron-3-ultra-550b-a55b', 'nemotron-3-ultra-free'] },
              { label: 'minimax-m2-7', score: 85, modelKeys: ['minimax-m2-7'], groupKeys: ['minimax-m2-7'] },
              { label: 'deepseek-v4-flash', score: 62, modelKeys: ['deepseek-v4-flash', 'deepseek-v4-flash-free'], groupKeys: ['deepseek-v4-flash', 'deepseek-v4-flash-free', 'deepseek/deepseek-v4-flash'] },
              { label: 'minimax-m3', score: 98, modelKeys: ['minimax-m3-free'], groupKeys: ['minimax-m3'] },
              { label: 'mimo-v2.5-free', score: 74, modelKeys: ['mimo-v2-5-free'], groupKeys: ['mimo-v2-5-free'] },
              { label: 'laguna-m-1', score: 74, modelKeys: ['laguna-m-1:free'], groupKeys: ['laguna-m-1:free'] },
              { label: 'step-3-7-flash', score: 65, modelKeys: ['step-3-7-flash:free'], groupKeys: ['step-3-7-flash:free'] },
            ];

    for (const { label, score, modelKeys, groupKeys } of expected) {
      const modelPlaceholders = modelKeys.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT platform, model_id, canonical_model_key, benchmark_score, intelligence_rank, size_label
          FROM models
         WHERE canonical_model_key IN (${modelPlaceholders})
         ORDER BY platform, model_id
      `).all(...modelKeys) as Array<{
        platform: string;
        model_id: string;
        canonical_model_key: string;
        benchmark_score: number;
        intelligence_rank: number;
        size_label: string;
      }>;

      const seenModelKeys = new Set(rows.map(r => r.canonical_model_key));
      for (const key of modelKeys) {
        expect(seenModelKeys.has(key), `${label} model ${key}`).toBe(true);
      }
      expect(rows.every(r => r.benchmark_score === score), label).toBe(true);
      expect(rows.every(r => r.intelligence_rank === scoreToIntelligenceRank(score)), label).toBe(true);
      expect(rows.every(r => r.size_label === 'Frontier'), label).toBe(true);

      const groupPlaceholders = groupKeys.map(() => '?').join(', ');
      const groups = db.prepare(`
        SELECT group_key, benchmark_score, intelligence_rank, size_label
          FROM model_groups
         WHERE group_key IN (${groupPlaceholders})
      `).all(...groupKeys) as Array<{ group_key: string; benchmark_score: number; intelligence_rank: number; size_label: string }>;

      const seenGroupKeys = new Set(groups.map(g => g.group_key));
      for (const key of groupKeys) {
        expect(seenGroupKeys.has(key), `${label} group ${key}`).toBe(true);
      }
      expect(groups.every(g => g.benchmark_score === score), label).toBe(true);
      expect(groups.every(g => g.intelligence_rank === scoreToIntelligenceRank(score)), label).toBe(true);
      expect(groups.every(g => g.size_label === 'Frontier'), label).toBe(true);
    }
  });

  it('V25: dead OpenCode Zen free promos (nemotron-3-super-free, minimax-m3-free) are disabled', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const dead = db.prepare(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'opencode' AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number }[];
    expect(dead.map(r => [r.model_id, r.enabled])).toEqual([
      ['minimax-m3-free',       0],
      ['nemotron-3-super-free', 0],
    ]);
  });

  it('all enabled catalog platforms have a registered provider', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');
    const { hasProvider } = await import('../../providers/index.js');

    const platforms = (db.prepare(
      `SELECT DISTINCT platform FROM models WHERE enabled = 1`
    ).all() as { platform: any }[]).map(r => r.platform);

    const missing = platforms.filter(p => !hasProvider(p));
    expect(missing).toEqual([]);
  });
});
