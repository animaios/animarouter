import type { Request, Response } from "express";
import { Router } from "express";
import { getDb, getSetting } from "../db/index.js";
import {
  invalidateAliasCache,
  normalizeGroupAlias,
  normalizeGroupKey,
  propagateGroupProperties,
  reconcileGroups,
  syncFallbackConfigGroupIds,
} from "../db/model-groups.js";
import { getAllProviders, hasProvider } from "../providers/index.js";
import { syncModelsFromProvider } from "./custom.js";

export const modelsRouter = Router();

// List all models with availability info
modelsRouter.get("/", (_req: Request, res: Response) => {
  const db = getDb();
  const models = db
    .prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled,
           mg.group_key, mg.display_name as group_display_name
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN model_groups mg ON mg.id = m.group_id
    ORDER BY COALESCE(fc.priority, m.benchmark_score, m.intelligence_rank) ASC
  `)
    .all() as any[];

  // Count keys per platform
  const keyCounts = db
    .prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `)
    .all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map((k) => [k.platform, k.count]));

  const result = models.map((m) => ({
    id: m.id,
    platform: m.platform,
    modelId: `${m.platform}/${m.model_id}`,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    benchmarkScore: m.benchmark_score,
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
    groupId: m.group_id,
    groupKey: m.group_key,
    groupDisplayName: m.group_display_name,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});

// ── Model sync-all ────────────────────────────────────────────────────────
// Discovers models from every built-in and custom provider, inserting any new
// ones (matched by platform + model_id) at the end of the fallback chain.
// Keyless providers and providers without a baseUrl are skipped gracefully.
modelsRouter.post("/sync-all", async (_req: Request, res: Response) => {
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
  const customRows = db
    .prepare(
      "SELECT slug, base_url, api_format FROM custom_providers WHERE archived = 0 AND api_format != 'anthropic'",
    )
    .all() as { slug: string; base_url: string; api_format: string }[];
  for (const r of customRows) {
    targets.push({ slug: r.slug, baseUrl: r.base_url });
  }

  let totalFetched = 0;
  const errors: { slug: string; error: string }[] = [];
  // model_ids newly added per provider — surfaces as a toast on the client
  // (manual click + auto-sync every 5min) so the user knows models appeared.
  const added_by_provider: Record<string, string[]> = {};

  for (const t of targets) {
    const result = await syncModelsFromProvider(t.baseUrl, t.slug, true); // Auto-enable in bulk sync
    totalFetched += result.fetched;
    if (result.error) {
      errors.push({ slug: t.slug, error: result.error });
    }
    if (result.added.length > 0) {
      added_by_provider[t.slug] = result.added;
    }
  }

  res.json({
    success: true,
    fetched: totalFetched,
    providers: targets.length,
    errors,
    added_by_provider,
  });
});

// ── Model Groups ──────────────────────────────────────────────────────────
// CRUD for model groups, aliases, and group-level property updates.

// GET /api/models/groups — list all groups
modelsRouter.get("/groups", (_req: Request, res: Response) => {
  const db = getDb();
  const groups = db
    .prepare(`
    SELECT mg.*, COUNT(m.id) AS model_count
    FROM model_groups mg
    LEFT JOIN models m ON m.group_id = mg.id
    GROUP BY mg.id
    ORDER BY mg.intelligence_rank ASC
  `)
    .all() as any[];

  res.json(
    groups.map((g) => ({
      id: g.id,
      groupKey: g.group_key,
      displayName: g.display_name,
      benchmarkScore: g.benchmark_score,
      intelligenceRank: g.intelligence_rank,
      sizeLabel: g.size_label,
      contextWindow: g.context_window,
      maxOutputTokens: g.max_output_tokens,
      supportsVision: g.supports_vision === 1,
      supportsTools: g.supports_tools === 1,
      enabled: g.enabled === 1,
      modelCount: g.model_count,
    })),
  );
});

// POST /api/models/groups/aliases — create an alias
modelsRouter.post("/groups/aliases", (req: Request, res: Response) => {
  const { alias, groupKey } = req.body as { alias?: string; groupKey?: string };
  if (
    typeof alias !== "string" ||
    typeof groupKey !== "string" ||
    !alias.trim() ||
    !groupKey.trim()
  ) {
    res.status(400).json({ error: "alias and groupKey are required" });
    return;
  }

  const db = getDb();
  const normalizedAlias = normalizeGroupAlias(alias);
  const normalizedGroupKey = normalizeGroupKey(groupKey);

  // Verify the target group exists
  const group = db
    .prepare("SELECT id FROM model_groups WHERE group_key = ?")
    .get(normalizedGroupKey) as { id: number } | undefined;
  if (!group) {
    res.status(404).json({ error: `Group "${normalizedGroupKey}" not found` });
    return;
  }

  const write = db
    .prepare(`
    INSERT INTO model_group_aliases (alias, group_key)
    VALUES (?, ?)
    ON CONFLICT(alias) DO UPDATE SET group_key = excluded.group_key
    WHERE model_group_aliases.group_key != excluded.group_key
  `)
    .run(normalizedAlias, normalizedGroupKey);

  invalidateAliasCache();
  const result = reconcileGroups(db);
  syncFallbackConfigGroupIds(db);
  res
    .status(write.changes > 0 ? 201 : 200)
    .json({ alias: normalizedAlias, groupKey: normalizedGroupKey, ...result });
});

// DELETE /api/models/groups/aliases/:alias — delete an alias
modelsRouter.delete("/groups/aliases/:alias", (req: Request, res: Response) => {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM model_group_aliases WHERE alias = ?")
    .run(normalizeGroupAlias(req.params.alias as string));
  if (result.changes === 0) {
    res.status(404).json({ error: "Alias not found" });
    return;
  }
  invalidateAliasCache();
  reconcileGroups(db);
  syncFallbackConfigGroupIds(db);
  res.json({ success: true });
});

// DELETE /api/models/groups/:groupId — archive every provider row in a model group.
modelsRouter.delete("/groups/:groupId", (req: Request, res: Response) => {
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0) {
    res.status(400).json({ error: "invalid group id" });
    return;
  }

  const db = getDb();
  const group = db
    .prepare("SELECT id FROM model_groups WHERE id = ?")
    .get(groupId) as { id: number } | undefined;
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }

  const providerRows = db
    .prepare("SELECT id FROM models WHERE group_id = ? AND enabled = 1")
    .all(groupId) as Array<{ id: number }>;
  if (providerRows.length === 0) {
    res.status(400).json({ error: "model group is already archived" });
    return;
  }

  const providerIds = providerRows.map((row) => row.id);
  const placeholders = providerIds.map(() => "?").join(", ");
  const archiveGroup = db.transaction(() => {
    db.prepare("DELETE FROM fallback_config WHERE group_id = ?").run(groupId);
    db.prepare(
      `DELETE FROM fallback_config WHERE model_db_id IN (${placeholders})`,
    ).run(...providerIds);
    db.prepare(
      "UPDATE models SET enabled = 0 WHERE group_id = ? AND enabled = 1",
    ).run(groupId);
  });
  archiveGroup();

  res.json({
    success: true,
    groupId,
    archived: true,
    archivedModels: providerIds.length,
  });
});

// PATCH /api/models/groups/:groupKey — update group properties
modelsRouter.patch("/groups/:groupKey", (req: Request, res: Response) => {
  const db = getDb();
  const group = db
    .prepare("SELECT id FROM model_groups WHERE group_key = ?")
    .get(req.params.groupKey) as { id: number } | undefined;
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }

  const allowed = [
    "display_name",
    "benchmark_score",
    "intelligence_rank",
    "size_label",
    "context_window",
    "max_output_tokens",
    "supports_vision",
    "supports_tools",
    "enabled",
  ];
  const updates: string[] = [];
  const values: any[] = [];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  values.push(group.id);
  db.prepare(`UPDATE model_groups SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values,
  );

  // Propagate updated properties to member models
  propagateGroupProperties(db, group.id);

  const updated = db
    .prepare("SELECT * FROM model_groups WHERE id = ?")
    .get(group.id) as any;
  res.json({
    success: true,
    groupKey: updated.group_key,
    displayName: updated.display_name,
    benchmarkScore: updated.benchmark_score,
    intelligenceRank: updated.intelligence_rank,
    sizeLabel: updated.size_label,
    contextWindow: updated.context_window,
    maxOutputTokens: updated.max_output_tokens,
    supportsVision: updated.supports_vision === 1,
    supportsTools: updated.supports_tools === 1,
  });
});
