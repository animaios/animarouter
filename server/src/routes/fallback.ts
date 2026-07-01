import type { ProviderRoutingStrategy } from "@animarouter/shared/types.js";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { getDb, getSetting } from "../db/index.js";
import {
  getAllStatesView,
  getBoost,
  resetBoost,
  setBoost,
} from "../services/degradation.js";
import {
  getProviderStrategy,
  listProviderStrategies,
  setProviderStrategy,
} from "../services/provider-strategy.js";
import {
  getAllPenalties,
  getCustomWeights,
  getRoutingScores,
  getRoutingStrategy,
  refreshStatsCache,
  setCustomWeights,
  setRoutingStrategy,
} from "../services/router.js";
import { BANDIT_PRESETS, type RoutingStrategy } from "../services/scoring.js";

export const fallbackRouter = Router();

const NEUTRAL_BOOST = 1.0;
const BOOST_EPSILON = 0.01;

function summarizeProviderBoost(providerIds: number[]): number {
  const boosts = providerIds.map((id) => getBoost(id));
  const nonNeutral = boosts.filter(
    (boost) => Math.abs(boost - NEUTRAL_BOOST) > BOOST_EPSILON,
  );
  if (nonNeutral.length === 0) return NEUTRAL_BOOST;

  const hasBoosted = nonNeutral.some((boost) => boost > NEUTRAL_BOOST);
  const hasDemoted = nonNeutral.some((boost) => boost < NEUTRAL_BOOST);
  if (hasBoosted && hasDemoted) return NEUTRAL_BOOST;

  return hasBoosted ? Math.max(...nonNeutral) : Math.min(...nonNeutral);
}

function parsePositiveIntParam(
  value: string | string[] | undefined,
): number | null {
  const parsed = Number.parseInt(
    Array.isArray(value) ? value[0] : String(value),
    10,
  );
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getEnabledGroupProviderIds(groupId: number): number[] | null {
  const db = getDb();
  const group = db
    .prepare("SELECT id FROM model_groups WHERE id = ? AND enabled = 1")
    .get(groupId) as { id: number } | undefined;
  if (!group) return null;

  const providers = db
    .prepare("SELECT id FROM models WHERE group_id = ?")
    .all(groupId) as Array<{ id: number }>;
  return providers.map((provider) => provider.id);
}

// ── Bandit routing strategy ─────────────────────────────────────────────────
// GET  /routing → active strategy, preset weights, the saved custom weights,
//                 and the per-model score breakdown (reliability / speed /
//                 intelligence + guardrails).
fallbackRouter.get("/routing", (_req: Request, res: Response) => {
  res.json({ ...getRoutingScores(), customWeights: getCustomWeights() });
});

// Get real performance data with actual token/sec values and sorting
// Returns models sorted by actual token/sec performance from real data
fallbackRouter.get("/performance", (_req: Request, res: Response) => {
  try {
    const db = getDb();
    refreshStatsCache(db, true);

    const rows = db
      .prepare(`
      SELECT m.id, m.platform, m.model_id, m.display_name,
             m.intelligence_rank, m.speed_rank, m.size_label,
             m.rpm_limit, m.rpd_limit,
             m.tpm_limit, m.tpd_limit, m.context_window, m.max_output_tokens,
             m.supports_vision, m.supports_tools,
              fc.priority,
             s.successes, s.failures, s.tokPerSec, s.avgTtfbMs
      FROM models m
      LEFT JOIN fallback_config fc ON m.id = fc.model_db_id
      LEFT JOIN model_stats_cache s ON m.platform = s.platform AND m.model_id = s.model_id
      WHERE m.enabled = 1 AND (fc.enabled IS NULL OR fc.enabled = 1)
      ORDER BY s.tokPerSec DESC NULLS LAST, m.intelligence_rank ASC
    `)
      .all() as Array<{
      id: number;
      platform: string;
      model_id: string;
      display_name: string;
      intelligence_rank: number;
      speed_rank: number;
      size_label: string;
      rpm_limit: number | null;
      rpd_limit: number | null;
      tpm_limit: number | null;
      tpd_limit: number | null;
      context_window: number | null;
      max_output_tokens: number | null;
      supports_vision: boolean;
      supports_tools: boolean;
      priority: number;
      successes: number;
      failures: number;
      tokPerSec: number;
      avgTtfbMs: number | null;
    }>;

    const performanceData = rows.map((row) => ({
      modelDbId: row.id,
      platform: row.platform,
      modelId: row.model_id,
      displayName: row.display_name,
      intelligenceRank: row.intelligence_rank,
      speedRank: row.speed_rank,
      sizeLabel: row.size_label,
      rpmLimit: row.rpm_limit,
      rpdLimit: row.rpd_limit,
      tpmLimit: row.tpm_limit,
      tpdLimit: row.tpd_limit,
      contextWindow: row.context_window,
      maxOutputTokens: row.max_output_tokens,
      supportsVision: row.supports_vision,
      supportsTools: row.supports_tools,
      enabled: true,
      priority: row.priority,
      chainEnabled: true,
      // Real performance metrics
      actualTokPerSec: row.tokPerSec || 0,
      actualAvgTtfbMs: row.avgTtfbMs,
      totalRequests: row.successes + row.failures,
      successRate:
        row.failures > 0
          ? (row.successes / (row.successes + row.failures)) * 100
          : 100,
    }));

    res.json(performanceData);
  } catch (error) {
    console.error("[Fallback] Performance endpoint error:", error);
    res.status(500).json({
      error: {
        message: "Failed to fetch performance data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }
});

const routingSchema = z.object({
  strategy: z.enum([
    "priority",
    "balanced",
    "smartest",
    "iterative_refinement",
    "fastest",
    "reliable",
    "custom",
    "racing",
  ]),
  // Only meaningful with strategy 'custom'. Any non-negative vector with a
  // positive sum is accepted; the server normalizes it to sum to 1.
  weights: z
    .object({
      reliability: z.number().min(0).max(1),
      speed: z.number().min(0).max(1),
      intelligence: z.number().min(0).max(1),
      latency: z.number().min(0).max(1),
    })
    .refine((w) => w.reliability + w.speed + w.intelligence + w.latency > 0, {
      message: "weights must not all be zero",
    })
    .optional(),
});

// PUT /routing → switch strategy. Presets are just weight vectors over the three
// axes; 'custom' uses the user-saved vector; 'priority' falls back to the legacy
// manual chain order.
fallbackRouter.put("/routing", (req: Request, res: Response) => {
  const parsed = routingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors.map((e) => e.message).join(", "),
      },
    });
    return;
  }
  if (parsed.data.strategy === "custom" && parsed.data.weights) {
    setCustomWeights(parsed.data.weights);
  }
  setRoutingStrategy(parsed.data.strategy as RoutingStrategy);
  res.json({
    strategy: getRoutingStrategy(),
    presets: BANDIT_PRESETS,
    customWeights: getCustomWeights(),
  });
});

// ── Per-provider routing strategy overrides ─────────────────────────────────
// GET  /routing/provider            → list all platform → strategy rows.
// GET  /routing/provider?platform=X → single row (404 if no row for X).
// PUT  /routing/provider            → write {platform, strategy}. Strategy
//                                     MUST be one of VALID_STRATEGIES. The
//                                     endpoint is decoupled from the global
//                                     PUT /routing — global rejects `auto`.
const VALID_PROVIDER_STRATEGIES: readonly string[] = [
  "priority",
  "balanced",
  "smartest",
  "iterative_refinement",
  "fastest",
  "reliable",
  "custom",
  "racing",
  "auto",
];

const providerStrategySchema = z.object({
  platform: z.string().min(1),
  strategy: z.enum(VALID_PROVIDER_STRATEGIES as [string, ...string[]]),
});

fallbackRouter.get("/routing/provider", (req: Request, res: Response) => {
  const platform =
    typeof req.query.platform === "string" ? req.query.platform : undefined;
  if (platform) {
    const strategy = getProviderStrategy(platform);
    if (strategy === null) {
      res.status(404).json({
        error: { message: `No strategy found for platform '${platform}'` },
      });
      return;
    }
    res.json({ platform, strategy, updated_at: new Date().toISOString() });
    return;
  }
  const rows = listProviderStrategies();
  res.json(rows);
});

fallbackRouter.put("/routing/provider", (req: Request, res: Response) => {
  const parsed = providerStrategySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors.map((e) => e.message).join(", "),
      },
    });
    return;
  }
  const { platform, strategy } = parsed.data;
  const row = setProviderStrategy(
    platform,
    strategy as ProviderRoutingStrategy,
  );
  res.json(row);
});

// Get fallback chain (with dynamic penalties)
fallbackRouter.get("/", (_req: Request, res: Response) => {
  const db = getDb();
  const groupingEnabled = getSetting("model_grouping_enabled") === "true";
  if (groupingEnabled) {
    const groups = db
      .prepare(`
      SELECT fc.group_id, fc.priority,
             mg.group_key, mg.display_name, mg.intelligence_rank,
             mg.size_label, mg.context_window, mg.max_output_tokens,
             mg.supports_vision, mg.supports_tools
      FROM fallback_config fc
      JOIN model_groups mg ON mg.id = fc.group_id
      WHERE fc.enabled = 1 AND mg.enabled = 1
      ORDER BY fc.priority ASC
    `)
      .all() as Array<{
      group_id: number;
      priority: number;
      group_key: string;
      display_name: string;
      intelligence_rank: number;
      size_label: string;
      context_window: number | null;
      max_output_tokens: number | null;
      supports_vision: number;
      supports_tools: number;
    }>;

    const providers = db
      .prepare(`
      SELECT m.id, m.group_id, m.platform, m.model_id, m.display_name,
             m.speed_rank, m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
             m.context_window, m.max_output_tokens, m.supports_vision, m.supports_tools
      FROM models m
      WHERE m.enabled = 1 AND m.group_id IS NOT NULL
    `)
      .all() as Array<{
      id: number;
      group_id: number;
      platform: string;
      model_id: string;
      display_name: string;
      speed_rank: number;
      rpm_limit: number | null;
      rpd_limit: number | null;
      tpm_limit: number | null;
      tpd_limit: number | null;
      context_window: number | null;
      max_output_tokens: number | null;
      supports_vision: number;
      supports_tools: number;
    }>;

    const keyCounts = db
      .prepare(`
      SELECT platform, COUNT(*) as count
      FROM api_keys WHERE enabled = 1
      GROUP BY platform
    `)
      .all() as { platform: string; count: number }[];
    const keyCountMap = new Map(keyCounts.map((k) => [k.platform, k.count]));
    const providersByGroup = new Map<
      number,
      Array<{
        id: number;
        group_id: number;
        platform: string;
        model_id: string;
        display_name: string;
        speed_rank: number;
        rpm_limit: number | null;
        rpd_limit: number | null;
        tpm_limit: number | null;
        tpd_limit: number | null;
        context_window: number | null;
        max_output_tokens: number | null;
        supports_vision: number;
        supports_tools: number;
      }>
    >();
    for (const provider of providers) {
      const list = providersByGroup.get(provider.group_id);
      if (list) list.push(provider);
      else providersByGroup.set(provider.group_id, [provider]);
    }

    const penalties = getAllPenalties();
    const penaltyMap = new Map(penalties.map((p) => [p.modelDbId, p]));

    res.json(
      groups.map((g) => {
        const groupProviders = providersByGroup.get(g.group_id) ?? [];
        const groupPenalty = groupProviders.reduce((max, p) => {
          const penalty = penaltyMap.get(p.id)?.penalty ?? 0;
          return Math.max(max, penalty);
        }, 0);
        const providerIds = groupProviders.map((p) => p.id);
        const keyCount = [
          ...new Set(groupProviders.map((p) => p.platform)),
        ].reduce((sum, platform) => sum + (keyCountMap.get(platform) ?? 0), 0);
        const speedRanks = groupProviders
          .map((p) => p.speed_rank)
          .filter((rank): rank is number => typeof rank === "number");

        return {
          isGroup: true,
          modelDbId: -g.group_id,
          groupId: g.group_id,
          groupKey: g.group_key,
          groupDisplayName: g.display_name,
          providerCount: groupProviders.length,
          priority: g.priority,
          effectivePriority: g.priority + groupPenalty,
          penalty: groupPenalty,
          rateLimitHits: 0,
          boost: summarizeProviderBoost(providerIds),
          enabled: true,
          platform: groupProviders.map((p) => p.platform).join(", "),
          modelId: g.group_key,
          displayName: g.display_name,
          intelligenceRank: g.intelligence_rank,
          speedRank: speedRanks.length > 0 ? Math.min(...speedRanks) : 99,
          sizeLabel: g.size_label,
          rpmLimit: null,
          rpdLimit: null,
          tpmLimit: null,
          tpdLimit: null,
          contextWindow: g.context_window,
          maxOutputTokens: g.max_output_tokens,
          supportsVision: g.supports_vision === 1,
          supportsTools: g.supports_tools === 1,
          keyCount,
          providers: groupProviders.map((p) => ({
            modelDbId: p.id,
            platform: p.platform,
            modelId: p.model_id,
            displayName: p.display_name,
            keyCount: keyCountMap.get(p.platform) ?? 0,
          })),
        };
      }),
    );
    return;
  }

  const rows = db
    .prepare(`
    SELECT fc.model_db_id, fc.priority,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.tpm_limit, m.tpd_limit,
           m.context_window, m.max_output_tokens, m.supports_vision, m.supports_tools,
           m.group_id, mg.group_key, mg.display_name as group_display_name
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    LEFT JOIN model_groups mg ON mg.id = m.group_id
    WHERE fc.enabled = 1 AND m.enabled = 1
    ORDER BY fc.priority ASC
`)
    .all() as Array<{
    model_db_id: number;
    priority: number;
    platform: string;
    model_id: string;
    display_name: string;
    intelligence_rank: number;
    speed_rank: number;
    size_label: string;
    rpm_limit: number | null;
    rpd_limit: number | null;
    tpm_limit: number | null;
    tpd_limit: number | null;
    context_window: number | null;
    max_output_tokens: number | null;
    supports_vision: number;
    supports_tools: number;
    group_id: number | null;
    group_key: string | null;
    group_display_name: string | null;
  }>;

  // Count enabled keys per platform
  const keyCounts = db
    .prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
    GROUP BY platform
  `)
    .all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map((k) => [k.platform, k.count]));

  // Get current dynamic penalties
  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map((p) => [p.modelDbId, p]));

  res.json(
    rows.map((r) => {
      const penalty = penaltyMap.get(r.model_db_id);
      return {
        modelDbId: r.model_db_id,
        priority: r.priority,
        effectivePriority: r.priority + (penalty?.penalty ?? 0),
        penalty: penalty?.penalty ?? 0,
        rateLimitHits: penalty?.count ?? 0,
        boost: getBoost(r.model_db_id),
        enabled: true,
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
        contextWindow: r.context_window,
        maxOutputTokens: r.max_output_tokens,
        supportsVision: r.supports_vision === 1,
        supportsTools: r.supports_tools === 1,
        groupId: r.group_id,
        groupKey: r.group_key,
        groupDisplayName: r.group_display_name,
        keyCount: keyCountMap.get(r.platform) ?? 0,
      };
    }),
  );
});

const updateSchema = z.array(
  z
    .object({
      modelDbId: z.number().optional(),
      groupId: z.number().optional(),
      priority: z.number(),
    })
    .refine(
      (entry) => entry.modelDbId !== undefined || entry.groupId !== undefined,
      {
        message: "modelDbId or groupId is required",
      },
    ),
);

// Update fallback chain (full replace)
fallbackRouter.put("/", (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors.map((e) => e.message).join(", "),
      },
    });
    return;
  }

  const db = getDb();
  const groupingEnabled = getSetting("model_grouping_enabled") === "true";
  const updateModel = db.prepare(
    "UPDATE fallback_config SET priority = ? WHERE model_db_id = ?",
  );
  const updateGroup = db.prepare(
    "UPDATE fallback_config SET priority = ? WHERE group_id = ?",
  );

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      if (groupingEnabled && entry.groupId !== undefined) {
        updateGroup.run(entry.priority, entry.groupId);
      } else if (entry.modelDbId !== undefined) {
        updateModel.run(entry.priority, entry.modelDbId);
      }
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
  speed: "m.speed_rank ASC",
  // budget sort removed — token system disabled
  // Sort by actual real token/sec performance from collected data
  real_speed: "s.tokPerSec DESC NULLS LAST, m.intelligence_rank ASC",
};

fallbackRouter.post("/sort/:preset", (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const orderBy = SORT_PRESETS[preset];
  if (!orderBy) {
    res.status(400).json({
      error: {
        message: `Unknown preset: ${preset}. Use: intelligence, speed, real_speed`,
      },
    });
    return;
  }

  const db = getDb();

  // For real_speed sorting, we need to join with performance data
  let query: string;
  if (preset === "real_speed") {
    // Refresh stats to ensure we have the latest performance data
    refreshStatsCache(db, true);
    query = `
      SELECT m.id
      FROM models m
      LEFT JOIN model_stats_cache s ON m.platform = s.platform AND m.model_id = s.model_id
      ORDER BY ${orderBy}
    `;
  } else {
    query = `SELECT m.id FROM models m ORDER BY ${orderBy}`;
  }

  const models = db.prepare(query).all() as { id: number }[];

  const update = db.prepare(
    "UPDATE fallback_config SET priority = ? WHERE model_db_id = ?",
  );
  const reorder = db.transaction(() => {
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });
  reorder();

  res.json({ success: true, preset });
});

// Token budget system removed — endpoint deleted.

// ── Degradation dashboard API ─────────────────────────────────────────────────
// GET /degradation → per-model penalty state, display tier, consecutive hits,
// estimated recovery time, and boost multiplier. Uses decayed view (not raw stored penalties).
fallbackRouter.get("/degradation", (_req: Request, res: Response) => {
  const db = getDb();
  const states = getAllStatesView();
  const result: Array<{
    modelDbId: number;
    platform: string | null;
    modelId: string | null;
    displayName: string | null;
    penalty: number;
    displayTier: string;
    consecutiveHits: number;
    consecutiveMajorHits: number;
    halfLifeMs: number;
    estimatedRecoveryMs: number | null;
    lastHitAt: number;
    boost: number;
  }> = [];
  for (const [modelDbId, state] of states) {
    const model = db
      .prepare(
        "SELECT platform, model_id, display_name FROM models WHERE id = ?",
      )
      .get(modelDbId) as
      | { platform: string; model_id: string; display_name: string }
      | undefined;
    result.push({
      modelDbId,
      platform: model?.platform ?? null,
      modelId: model?.model_id ?? null,
      displayName: model?.display_name ?? null,
      penalty: state.penalty,
      displayTier: state.displayTier,
      consecutiveHits: state.consecutiveHits,
      consecutiveMajorHits: state.consecutiveMajorHits,
      halfLifeMs: state.halfLifeMs,
      estimatedRecoveryMs:
        state.penalty > 1 ? state.halfLifeMs * Math.log2(state.penalty) : null,
      lastHitAt: state.lastHitAt,
      boost: state.boost,
    });
  }
  res.json(result);
});

// ── Boost multiplier API ─────────────────────────────────────────────────────
// GET /boost → all models with a non-default boost (boost != 1.0)
fallbackRouter.get("/boost", (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT model_db_id, boost FROM model_degradation WHERE boost != 1.0",
    )
    .all() as Array<{ model_db_id: number; boost: number }>;
  res.json(rows.map((r) => ({ modelDbId: r.model_db_id, boost: r.boost })));
});

const boostSchema = z.object({
  boost: z.number().finite().positive(),
});

// PUT /boost/groups/:groupId → set boost multiplier for every enabled provider in a group.
fallbackRouter.put("/boost/groups/:groupId", (req: Request, res: Response) => {
  const groupId = parsePositiveIntParam(req.params.groupId);
  if (groupId === null) {
    res
      .status(400)
      .json({ error: { message: "groupId must be a positive number" } });
    return;
  }

  const parsed = boostSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors.map((e) => e.message).join(", "),
      },
    });
    return;
  }

  const providerIds = getEnabledGroupProviderIds(groupId);
  if (providerIds === null) {
    res.status(404).json({ error: { message: "Model group not found" } });
    return;
  }

  const db = getDb();
  const persistBoost = db.prepare(`
    INSERT INTO model_degradation (model_db_id, penalty, tier, consecutive, consecutive_major, last_hit_at, half_life_ms, boost)
    VALUES (?, 0, 'minor', 0, 0, 0, 120000, ?)
    ON CONFLICT(model_db_id) DO UPDATE SET boost = excluded.boost
  `);
  const updateAll = db.transaction(() => {
    for (const modelDbId of providerIds) {
      setBoost(modelDbId, parsed.data.boost);
      persistBoost.run(modelDbId, getBoost(modelDbId));
    }
  });
  updateAll();

  res.json({
    groupId,
    modelDbIds: providerIds,
    boost: summarizeProviderBoost(providerIds),
  });
});

// DELETE /boost/groups/:groupId → reset boost for every enabled provider in a group.
fallbackRouter.delete(
  "/boost/groups/:groupId",
  (req: Request, res: Response) => {
    const groupId = parsePositiveIntParam(req.params.groupId);
    if (groupId === null) {
      res
        .status(400)
        .json({ error: { message: "groupId must be a positive number" } });
      return;
    }

    const providerIds = getEnabledGroupProviderIds(groupId);
    if (providerIds === null) {
      res.status(404).json({ error: { message: "Model group not found" } });
      return;
    }

    const db = getDb();
    const selectPenalty = db.prepare(
      "SELECT penalty FROM model_degradation WHERE model_db_id = ?",
    );
    const deleteBoostRow = db.prepare(
      "DELETE FROM model_degradation WHERE model_db_id = ?",
    );
    const resetBoostRow = db.prepare(
      "UPDATE model_degradation SET boost = 1.0 WHERE model_db_id = ?",
    );
    const resetAll = db.transaction(() => {
      for (const modelDbId of providerIds) {
        resetBoost(modelDbId);
        const row = selectPenalty.get(modelDbId) as
          | { penalty: number }
          | undefined;
        if (row) {
          if (row.penalty <= 0) {
            deleteBoostRow.run(modelDbId);
          } else {
            resetBoostRow.run(modelDbId);
          }
        }
      }
    });
    resetAll();

    res.json({ groupId, modelDbIds: providerIds, boost: NEUTRAL_BOOST });
  },
);

// PUT /boost/:modelDbId → set boost multiplier for a model, clamped to [boostMin, boostMax]
fallbackRouter.put("/boost/:modelDbId", (req: Request, res: Response) => {
  const modelDbId = parsePositiveIntParam(req.params.modelDbId);
  if (modelDbId === null) {
    res
      .status(400)
      .json({ error: { message: "modelDbId must be a positive number" } });
    return;
  }

  const parsed = boostSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.errors.map((e) => e.message).join(", "),
      },
    });
    return;
  }

  // Set boost (clamped internally) and persist immediately
  setBoost(modelDbId, parsed.data.boost);

  // Persist to DB immediately for API responsiveness
  const db = getDb();
  const currentBoost = getBoost(modelDbId);
  db.prepare(`
    INSERT INTO model_degradation (model_db_id, penalty, tier, consecutive, consecutive_major, last_hit_at, half_life_ms, boost)
    VALUES (?, 0, 'minor', 0, 0, 0, 120000, ?)
    ON CONFLICT(model_db_id) DO UPDATE SET boost = excluded.boost
  `).run(modelDbId, currentBoost);

  res.json({ modelDbId, boost: currentBoost });
});

// DELETE /boost/:modelDbId → reset boost to 1.0 (default)
fallbackRouter.delete("/boost/:modelDbId", (req: Request, res: Response) => {
  const modelDbId = parsePositiveIntParam(req.params.modelDbId);
  if (modelDbId === null) {
    res
      .status(400)
      .json({ error: { message: "modelDbId must be a positive number" } });
    return;
  }

  resetBoost(modelDbId);

  // Update DB: set boost = 1.0, or delete row if penalty is also 0
  const db = getDb();
  const row = db
    .prepare("SELECT penalty FROM model_degradation WHERE model_db_id = ?")
    .get(modelDbId) as { penalty: number } | undefined;
  if (row) {
    if (row.penalty <= 0) {
      db.prepare("DELETE FROM model_degradation WHERE model_db_id = ?").run(
        modelDbId,
      );
    } else {
      db.prepare(
        "UPDATE model_degradation SET boost = 1.0 WHERE model_db_id = ?",
      ).run(modelDbId);
    }
  }

  res.json({ modelDbId, boost: 1.0 });
});
