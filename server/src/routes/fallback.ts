import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties, getCustomWeights, getRoutingScores, getRoutingStrategy, setCustomWeights, setRoutingStrategy, getGlobalRetryLimit, setGlobalRetryLimit, refreshStatsCache } from '../services/router.js';
import { BANDIT_PRESETS, type RoutingStrategy } from '../services/scoring.js';
import { parseBudget } from '../lib/budget.js';

export const fallbackRouter = Router();

// ── Global retry limit ──────────────────────────────────────────────────────
fallbackRouter.get('/retry-limit', (_req: Request, res: Response) => {
  res.json({ limit: getGlobalRetryLimit() });
});

const retryLimitSchema = z.object({
  limit: z.number().int().min(0).max(100),
});

fallbackRouter.put('/retry-limit', (req: Request, res: Response) => {
  const parsed = retryLimitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Limit must be 0 (infinite) or 1-100' } });
    return;
  }
  setGlobalRetryLimit(parsed.data.limit);
  res.json({ limit: getGlobalRetryLimit() });
});

// ── Bandit routing strategy ─────────────────────────────────────────────────
// GET  /routing → active strategy, preset weights, the saved custom weights,
//                 and the per-model score breakdown (reliability / speed /
//                 intelligence + guardrails).
fallbackRouter.get('/routing', (_req: Request, res: Response) => {
  res.json({ ...getRoutingScores(), customWeights: getCustomWeights() });
});

// Get real performance data with actual token/sec values and sorting
// Returns models sorted by actual token/sec performance from real data
fallbackRouter.get('/performance', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    refreshStatsCache(db, true);

    const rows = db.prepare(`
      SELECT m.id, m.platform, m.model_id, m.display_name,
             m.intelligence_rank, m.speed_rank, m.size_label,
             m.monthly_token_budget, m.rpm_limit, m.rpd_limit,
             m.tpm_limit, m.tpd_limit, m.context_window, m.max_output_tokens,
             m.supports_vision, m.supports_tools, m.enabled,
             fc.priority, fc.enabled as chain_enabled,
             s.successes, s.failures, s.tokPerSec, s.avgTtfbMs, s.monthlyUsedTokens
      FROM models m
      LEFT JOIN fallback_config fc ON m.id = fc.model_db_id
      LEFT JOIN model_stats_cache s ON m.platform = s.platform AND m.model_id = s.model_id
      WHERE m.enabled = 1
      ORDER BY s.tokPerSec DESC NULLS LAST, m.intelligence_rank ASC
    `).all() as Array<{
      id: number; platform: string; model_id: string; display_name: string;
      intelligence_rank: number; speed_rank: number; size_label: string;
      monthly_token_budget: string; rpm_limit: number | null; rpd_limit: number | null;
      tpm_limit: number | null; tpd_limit: number | null; context_window: number | null;
      max_output_tokens: number | null; supports_vision: boolean; supports_tools: boolean;
      enabled: boolean; priority: number; chain_enabled: boolean;
      successes: number; failures: number; tokPerSec: number; avgTtfbMs: number | null;
      monthlyUsedTokens: number;
    }>;

    const performanceData = rows.map(row => ({
      modelDbId: row.id,
      platform: row.platform,
      modelId: row.model_id,
      displayName: row.display_name,
      intelligenceRank: row.intelligence_rank,
      speedRank: row.speed_rank,
      sizeLabel: row.size_label,
      monthlyTokenBudget: row.monthly_token_budget,
      rpmLimit: row.rpm_limit,
      rpdLimit: row.rpd_limit,
      tpmLimit: row.tpm_limit,
      tpdLimit: row.tpd_limit,
      contextWindow: row.context_window,
      maxOutputTokens: row.max_output_tokens,
      supportsVision: row.supports_vision,
      supportsTools: row.supports_tools,
      enabled: row.enabled,
      priority: row.priority,
      chainEnabled: row.chain_enabled,
      // Real performance metrics
      actualTokPerSec: row.tokPerSec || 0,
      actualAvgTtfbMs: row.avgTtfbMs,
      totalRequests: row.successes + row.failures,
      successRate: row.failures > 0 ? (row.successes / (row.successes + row.failures)) * 100 : 100,
      monthlyUsedTokens: row.monthlyUsedTokens
    }));

    res.json(performanceData);
  } catch (error) {
    console.error('[Fallback] Performance endpoint error:', error);
    res.status(500).json({
      error: {
        message: 'Failed to fetch performance data',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    });
  }
});

const routingSchema = z.object({
  strategy: z.enum(['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']),
  // Only meaningful with strategy 'custom'. Any non-negative vector with a
  // positive sum is accepted; the server normalizes it to sum to 1.
  weights: z.object({
    reliability: z.number().min(0).max(1),
    speed: z.number().min(0).max(1),
    intelligence: z.number().min(0).max(1),
  }).refine(w => w.reliability + w.speed + w.intelligence > 0, {
    message: 'weights must not all be zero',
  }).optional(),
});

// PUT /routing → switch strategy. Presets are just weight vectors over the three
// axes; 'custom' uses the user-saved vector; 'priority' falls back to the legacy
// manual chain order.
fallbackRouter.put('/routing', (req: Request, res: Response) => {
  const parsed = routingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  if (parsed.data.strategy === 'custom' && parsed.data.weights) {
    setCustomWeights(parsed.data.weights);
  }
  setRoutingStrategy(parsed.data.strategy as RoutingStrategy);
  res.json({ strategy: getRoutingStrategy(), presets: BANDIT_PRESETS, customWeights: getCustomWeights() });
});

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.tpm_limit, m.tpd_limit, m.monthly_token_budget,
           m.context_window, m.max_output_tokens, m.supports_vision, m.supports_tools
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE m.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as any[];

  // Count enabled keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  // Get current dynamic penalties
  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      tpmLimit: r.tpm_limit,
      tpdLimit: r.tpd_limit,
      monthlyTokenBudget: r.monthly_token_budget,
      contextWindow: r.context_window,
      maxOutputTokens: r.max_output_tokens,
      supportsVision: r.supports_vision === 1,
      supportsTools: r.supports_tools === 1,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

// Update fallback chain (full replace)
fallbackRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const update = db.prepare(`
    UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?
  `);

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
    }
  });
  updateAll();

  res.json({ success: true });
});

// `intelligence_rank` is scoped to each provider's own catalog — a provider's
// #1 model is not globally #1 (see issue #135: MiniMax's top model outranking
// Gemini Pro because both read "Intel #1"). `size_label` IS a cross-provider
// capability tier, so normalize on it first and use intelligence_rank only as
// an in-tier tiebreaker. Unknown labels sort last.
const INTELLIGENCE_TIER =
  "CASE m.size_label WHEN 'Frontier' THEN 1 WHEN 'Large' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Small' THEN 4 ELSE 5 END";

// Sort presets — `orderBy` is selected from a fixed whitelist, never from
// user input directly, so the interpolation below is safe.
const SORT_PRESETS: Record<string, string> = {
  intelligence: `${INTELLIGENCE_TIER} ASC, m.intelligence_rank ASC`,
  speed: 'm.speed_rank ASC',
  budget: "CASE m.monthly_token_budget WHEN '~120M' THEN 1 WHEN '~50-100M' THEN 2 WHEN '~30M' THEN 3 WHEN '~18-45M' THEN 4 WHEN '~18M' THEN 5 WHEN '~15M' THEN 6 WHEN '~12M' THEN 7 WHEN '~6M' THEN 8 WHEN '~5-10M' THEN 9 WHEN '~4M' THEN 10 ELSE 11 END ASC",
  // Sort by actual real token/sec performance from collected data
  real_speed: 's.tokPerSec DESC NULLS LAST, m.intelligence_rank ASC',
};

fallbackRouter.post('/sort/:preset', (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const orderBy = SORT_PRESETS[preset];
  if (!orderBy) {
    res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget, real_speed` } });
    return;
  }

  const db = getDb();

  // For real_speed sorting, we need to join with performance data
  let query;
  if (preset === 'real_speed') {
    // Refresh stats to ensure we have the latest performance data
    refreshStatsCache(db, true);
    query = `
      SELECT m.id
      FROM models m
      LEFT JOIN model_stats_cache s ON m.platform = s.platform AND m.model_id = s.model_id
      WHERE m.enabled = 1
      ORDER BY ${orderBy}
    `;
  } else {
    query = `SELECT m.id FROM models m ORDER BY ${orderBy}`;
  }

  const models = db.prepare(query).all() as { id: number }[];

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  const reorder = db.transaction(() => {
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });
  reorder();

  res.json({ success: true, preset });
});

// Token usage per model for the stacked bar
fallbackRouter.get('/token-usage', (_req: Request, res: Response) => {
  const db = getDb();

  // Get platforms that have enabled keys
  const platforms = db.prepare(`
    SELECT DISTINCT ak.platform
    FROM api_keys ak
    WHERE ak.enabled = 1
  `).all() as { platform: string }[];
  const platformSet = new Set(platforms.map(p => p.platform));

  // Get monthly budget per model, ordered by fallback priority
  const models = db.prepare(`
    SELECT m.platform, m.model_id, m.display_name, m.monthly_token_budget,
           fc.priority
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as { platform: string; model_id: string; display_name: string; monthly_token_budget: string; priority: number }[];

  // Build per-model breakdown (only platforms with keys)
  const modelBudgets = models
    .filter(m => platformSet.has(m.platform))
    .map(m => ({
      displayName: m.display_name,
      platform: m.platform,
      budget: parseBudget(m.monthly_token_budget),
    }));

  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);

  // Tokens used this month
  const usage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
      AND request_type = 'chat'
  `).get() as { total_used: number };

  res.json({
    totalBudget,
    totalUsed: usage.total_used,
    models: modelBudgets,
  });
});
