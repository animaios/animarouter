import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { hasProvider, getAllProviders } from '../providers/index.js';
import { syncModelsFromProvider } from './custom.js';

export const modelsRouter = Router();

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: `${m.platform}/${m.model_id}`,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    maxOutputTokens: m.max_output_tokens,
    enabled: m.enabled === 1,
    supportsVision: m.supports_vision === 1,
    supportsTools: m.supports_tools === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});

// ── Model sync-all ────────────────────────────────────────────────────────
// Discovers models from every built-in and custom provider, inserting any new
// ones (matched by platform + model_id) at the end of the fallback chain.
// Keyless providers and providers without a baseUrl are skipped gracefully.
modelsRouter.post('/sync-all', async (_req: Request, res: Response) => {
  const db = getDb();
  const builtins = getAllProviders();

  // Collect slugs + baseUrls from built-ins that expose a discoverable /models endpoint.
  const targets: { slug: string; baseUrl: string }[] = [];
  for (const p of builtins) {
    if (p.baseUrl) {
      targets.push({ slug: p.platform, baseUrl: p.baseUrl });
    }
  }

  // Add custom providers. Skip Anthropic-format rows: Anthropic has no
  // /v1/models endpoint, so there's nothing to discover.
  const customRows = db.prepare(
    "SELECT slug, base_url, api_format FROM custom_providers WHERE archived = 0 AND api_format != 'anthropic'",
  ).all() as { slug: string; base_url: string; api_format: string }[];
  for (const r of customRows) {
    targets.push({ slug: r.slug, baseUrl: r.base_url });
  }

  let totalFetched = 0;
  const errors: { slug: string; error: string }[] = [];

  for (const t of targets) {
    const result = await syncModelsFromProvider(t.baseUrl, t.slug);
    totalFetched += result.fetched;
    if (result.error) {
      errors.push({ slug: t.slug, error: result.error });
    }
  }

  res.json({
    success: true,
    fetched: totalFetched,
    providers: targets.length,
    errors,
  });
});
