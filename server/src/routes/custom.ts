import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { clearPlatformCaches } from '../services/ratelimit.js';
import { hasProvider, buildProviderFor } from '../providers/index.js';

export const customRouter = Router();

// Built-in platform slugs are off-limits as custom slugs — the catalog
// already binds those names. Reject early to avoid silent shadowing.
const BUILTIN_SLUGS = new Set([
  'google', 'groq', 'cerebras', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode',
  'ovh', 'commandcode',
]);

// Slug format: lowercase letters, digits, dashes. 2-32 chars. Cannot start or
// end with a dash.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const createProviderSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'slug must be 2-32 chars: lowercase letters, digits, dashes; cannot start or end with a dash'),
  displayName: z.string().min(1, 'displayName is required').max(80),
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  maxParallelRequests: z.number().int().min(1).nullable().optional(),
  keyless: z.boolean().optional(),
  apiFormat: z.enum(['openai', 'anthropic']).optional(),
  stickySessionsEnabled: z.boolean().optional(),
  autoEnableModels: z.boolean().optional(),
});

const updateProviderSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  slug: z.string().min(2).max(40).regex(SLUG_RE).optional(),
  baseUrl: z.string().url().optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  maxParallelRequests: z.number().int().min(1).nullable().optional(),
  keyless: z.boolean().optional(),
  apiFormat: z.enum(['openai', 'anthropic']).optional(),
  stickySessionsEnabled: z.boolean().optional(),
}).refine(d => d.displayName !== undefined || d.baseUrl !== undefined
  || d.slug !== undefined || d.tpmLimit !== undefined || d.tpdLimit !== undefined
  || d.maxParallelRequests !== undefined || d.keyless !== undefined || d.apiFormat !== undefined
  || d.stickySessionsEnabled !== undefined, {
    message: `At least one of displayName, slug, baseUrl, stickySessionsEnabled, or limit must be provided`,
  });
// tools by default (the most common case for OpenAI-compatible endpoints).
const MODEL_DEFAULTS = {
  intelligenceRank: 50,
  speedRank: 50,
  sizeLabel: 'Custom',
  monthlyTokenBudget: '',
  rpmLimit: null,
  rpdLimit: null,
  tpmLimit: null,
  tpdLimit: null,
  supportsTools: true,
  supportsVision: false,
};

const createModelSchema = z.object({
  modelId: z.string().min(1, 'modelId is required').max(120),
  displayName: z.string().min(1, 'displayName is required').max(120),
  contextWindow: z.number().int().positive().nullable().optional(),
  intelligenceRank: z.number().int().min(1).max(100).optional(),
  speedRank: z.number().int().min(1).max(100).optional(),
  sizeLabel: z.string().max(40).optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  monthlyTokenBudget: z.string().max(40).optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
});

const updateModelSchema = createModelSchema.partial().extend({
  enabled: z.boolean().optional(),
});
// Returns true if the slug belongs to a known provider — either a built-in
// (registered in providers/index.ts) or a custom provider (present in
// custom_providers). Models on either kind of platform are user-editable
// through /api/custom-* endpoints as long as they're in the models table.
function isKnownProvider(slug: string): boolean {
  return hasProvider(slug as any) || !!getDb().prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(slug);
}

// ── Model auto-discovery ────────────────────────────────────────────────
// Fetches models from {baseUrl}/models (OpenAI-compatible format) and
// inserts them into the catalog with sensible defaults. Existing models
// (matched by platform + model_id) are skipped so re-runs are safe.

export type ProviderSyncResult = {
  /** Count of newly inserted models (excludes already-registered rows). */
  fetched: number
  /** model_ids of rows this run actually inserted. */
  added: string[]
  error?: string
}

export async function syncModelsFromProvider(baseUrl: string, slug: string, autoEnableModels = true): Promise<ProviderSyncResult> {
  // Skip auto-discovery in test environments — fake provider URLs won't respond.
  if (process.env.VITEST) return { fetched: 0, added: [] };

  // Auto-discover models from the provider's /models endpoint. The autoEnableModels parameter controls:
  // - true: models are inserted with enabled=1 (automatically active)
  // - false: models are inserted with enabled=0 (must be manually enabled by user)
  // Default behavior (when not specified): true (models auto-enabled by default)

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      console.log(`[Custom] ${slug}: /models returned ${res.status}, skipping auto-discovery`);
      return { fetched: 0, added: [] };
    }

    const body: any = await res.json();
    const models = body?.data;
    if (!Array.isArray(models) || models.length === 0) {
      console.log(`[Custom] ${slug}: no models in /models response`);
      return { fetched: 0, added: [] };
    }

    const db = getDb();
    const added: string[] = [];
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number }).m;

    const insertModel = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools, max_output_tokens, key_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `);
    const insertFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)');

    const tx = db.transaction(() => {
      for (const m of models) {
        const modelId = typeof m.id === 'string' ? m.id.trim() : '';
        if (!modelId) continue;

        // Skip if already registered
        const exists = db.prepare('SELECT 1 FROM models WHERE platform = ? AND model_id = ?').get(slug, modelId);
        if (exists) continue;

        // Use the model id as display name (user can rename later).
        // Defaults match MODEL_DEFAULTS: middle ranks, no rate limits,
        // tools=true, vision=false, unknown context window.
        // OpenRouter / OpenCode enforcement: non-free models are always disabled
        // regardless of the autoEnableModels setting — only free-tier models
        // may be active. Case-insensitive match (free / Free / FREE all count).
        const isFreeOnlyProvider = slug === 'openrouter' || slug === 'opencode';
        const isNonFree = isFreeOnlyProvider && !modelId.toLowerCase().includes('free');
        const enabledFlag = isNonFree ? 0 : (autoEnableModels ? 1 : 0);

        const displayName = modelId;
        const result = insertModel.run(
          slug, modelId, displayName,
          MODEL_DEFAULTS.intelligenceRank, MODEL_DEFAULTS.speedRank, MODEL_DEFAULTS.sizeLabel,
          MODEL_DEFAULTS.rpmLimit, MODEL_DEFAULTS.rpdLimit, MODEL_DEFAULTS.tpmLimit, MODEL_DEFAULTS.tpdLimit,
          MODEL_DEFAULTS.monthlyTokenBudget, null, // context_window = unknown
          enabledFlag,
          MODEL_DEFAULTS.supportsVision ? 1 : 0, MODEL_DEFAULTS.supportsTools ? 1 : 0,
        );
        insertFb.run(Number(result.lastInsertRowid), maxPriority + added.length + 1, enabledFlag);
        added.push(modelId);
      }
    });
    tx();

    console.log(`[Custom] ${slug}: discovered ${added.length} models (${models.length} total, skipped ${models.length - added.length} existing)`);
    return { fetched: added.length, added };
  } catch (err: any) {
    const msg = err.name === 'AbortError' ? 'timeout' : err.message;
    console.log(`[Custom] ${slug}: model sync failed: ${msg}`);
    return { fetched: 0, added: [], error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Providers ──────────────────────────────────────────────────────────

// List all custom providers with per-provider model + enabled-key counts so
// the UI doesn't have to cross-reference.
customRouter.get('/api/custom-providers', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM custom_providers ORDER BY created_at ASC').all() as Array<{
    id: number; slug: string; display_name: string; base_url: string;
    rpm_limit: number | null; rpd_limit: number | null;
    tpm_limit: number | null; tpd_limit: number | null;
    max_parallel_requests: number | null;
    created_at: string;
    keyless: number;
    api_format: string;
    sticky_sessions_enabled: number;
    archived: number;
  }>;
  const modelCounts = db.prepare(`
    SELECT platform, COUNT(*) AS n FROM models GROUP BY platform
  `).all() as Array<{ platform: string; n: number }>;
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 GROUP BY platform
  `).all() as Array<{ platform: string; n: number }>;
  const modelByPlatform = new Map(modelCounts.map(r => [r.platform, r.n]));
  const keysByPlatform = new Map(keyCounts.map(r => [r.platform, r.n]));
  res.json(rows.map(r => ({
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    baseUrl: r.base_url,
    rpmLimit: r.rpm_limit,
    rpdLimit: r.rpd_limit,
    tpmLimit: r.tpm_limit,
    tpdLimit: r.tpd_limit,
    maxParallelRequests: r.max_parallel_requests,
    keyless: r.keyless === 1,
    apiFormat: r.api_format as 'openai' | 'anthropic',
    stickySessionsEnabled: r.sticky_sessions_enabled === 1,
    archived: r.archived === 1,
    createdAt: r.created_at,
    modelCount: modelByPlatform.get(r.slug) ?? 0,
    keyCount: keysByPlatform.get(r.slug) ?? 0,
  })));
});

// Create a provider. After inserting, auto-discovers models from {baseUrl}/models.
customRouter.post('/api/custom-providers', async (req: Request, res: Response) => {
  const parsed = createProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { slug, displayName, rpmLimit, rpdLimit, tpmLimit, tpdLimit, maxParallelRequests, keyless, apiFormat = 'openai', stickySessionsEnabled } = parsed.data;
  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');

  if (BUILTIN_SLUGS.has(slug)) {
    res.status(400).json({ error: { message: `slug '${slug}' is reserved by a built-in platform` } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT id, base_url, archived, display_name, rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM custom_providers WHERE slug = ?').get(slug) as {
    id: number; base_url: string; archived: number; display_name: string;
    rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null;
  } | undefined;

  if (existing) {
    if (existing.archived !== 1) {
      res.status(409).json({ error: { message: `provider with slug '${slug}' already exists` } });
      return;
    }
    if (existing.base_url !== baseUrl) {
      // Same slug, different base_url — rename the archived provider to free
      // up the slug, then create the new one as a fresh provider. The archived
      // one keeps its data for analytics and can be restored later (with its
      // renamed slug) or deleted through the Archived section.
      const newSlug = `${slug}-archived-${Date.now()}`;
      const tx = db.transaction(() => {
        db.prepare('UPDATE custom_providers SET slug = ? WHERE slug = ?').run(newSlug, slug);
        // Cascade the slug rename to api_keys and models so analytics stay
        // connected to the archived provider.
        db.prepare('UPDATE api_keys SET platform = ? WHERE platform = ?').run(newSlug, slug);
        db.prepare('UPDATE models SET platform = ? WHERE platform = ?').run(newSlug, slug);
        db.prepare('UPDATE requests SET platform = ? WHERE platform = ?').run(newSlug, slug);
      });
      tx();
      // Fall through to create new provider below.
    } else {
      // Same slug, same base_url — revive from archive.
      const tx = db.transaction(() => {
        db.prepare('UPDATE custom_providers SET archived = 0, display_name = ?, rpm_limit = ?, rpd_limit = ?, tpm_limit = ?, tpd_limit = ?, max_parallel_requests = ?, keyless = ?, api_format = ?, sticky_sessions_enabled = ? WHERE slug = ?')
          .run(displayName.trim(), rpmLimit ?? null, rpdLimit ?? null, tpmLimit ?? null, tpdLimit ?? null, maxParallelRequests ?? null, keyless ? 1 : 0, apiFormat, stickySessionsEnabled ? 1 : 0, slug);
        db.prepare('UPDATE api_keys SET enabled = 1 WHERE platform = ?').run(slug);
        db.prepare('UPDATE models SET enabled = 1 WHERE platform = ?').run(slug);
      });
      tx();

      clearPlatformCaches(slug);
      const sync = await syncModelsFromProvider(baseUrl, slug, parsed.data.autoEnableModels === true);
      res.json({
        id: existing.id, slug, displayName: displayName.trim(), baseUrl,
        rpmLimit: rpmLimit ?? null, rpdLimit: rpdLimit ?? null,
        tpmLimit: tpmLimit ?? null, tpdLimit: tpdLimit ?? null,
        maxParallelRequests: maxParallelRequests ?? null,
        keyless: !!keyless,
        apiFormat,
        stickySessionsEnabled: !!stickySessionsEnabled,
        modelCount: sync.fetched, revived: true,
      });
      return;
    }
  }

  const result = db.prepare(`
    INSERT INTO custom_providers (slug, display_name, base_url, rpm_limit, rpd_limit, tpm_limit, tpd_limit, max_parallel_requests, keyless, api_format, sticky_sessions_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, displayName.trim(), baseUrl, rpmLimit ?? null, rpdLimit ?? null, tpmLimit ?? null, tpdLimit ?? null, maxParallelRequests ?? null, keyless ? 1 : 0, apiFormat, stickySessionsEnabled ? 1 : 0);

  // Auto-discover models from the provider's /models endpoint (always enabled by default).
  const sync = await syncModelsFromProvider(baseUrl, slug, parsed.data.autoEnableModels !== false);

  res.status(201).json({
    id: result.lastInsertRowid,
    slug,
    displayName: displayName.trim(),
    baseUrl,
    rpmLimit: rpmLimit ?? null,
    rpdLimit: rpdLimit ?? null,
    tpmLimit: tpmLimit ?? null,
    tpdLimit: tpdLimit ?? null,
    maxParallelRequests: maxParallelRequests ?? null,
    keyless: !!keyless,
    apiFormat,
    stickySessionsEnabled: !!stickySessionsEnabled,
    modelCount: sync.fetched,
  });
});

// Edit display name or base URL.
customRouter.patch('/api/custom-providers/:slug', (req: Request, res: Response) => {
  let slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  const parsed = updateProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(slug);
  if (!existing) {
    res.status(404).json({ error: { message: `provider '${slug}' not found` } });
    return;
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  if (parsed.data.displayName !== undefined) {
    updates.push('display_name = ?');
    values.push(parsed.data.displayName.trim());
  }
  if (parsed.data.baseUrl !== undefined) {
    const trimmed = parsed.data.baseUrl.trim().replace(/\/+$/, '');
    updates.push('base_url = ?');
    values.push(trimmed);
    // Keep api_keys.base_url denormalized in sync so older code paths
    // (health checks) see the new endpoint immediately.
    db.prepare('UPDATE api_keys SET base_url = ? WHERE platform = ?').run(trimmed, slug);
  }
  if (parsed.data.rpmLimit !== undefined) {
    updates.push('rpm_limit = ?');
    values.push(parsed.data.rpmLimit);
  }
  if (parsed.data.rpdLimit !== undefined) {
    updates.push('rpd_limit = ?');
    values.push(parsed.data.rpdLimit);
  }
  if (parsed.data.tpmLimit !== undefined) {
    updates.push('tpm_limit = ?');
    values.push(parsed.data.tpmLimit);
  }
  if (parsed.data.tpdLimit !== undefined) {
    updates.push('tpd_limit = ?');
    values.push(parsed.data.tpdLimit);
  }
  if (parsed.data.maxParallelRequests !== undefined) {
    updates.push('max_parallel_requests = ?');
    values.push(parsed.data.maxParallelRequests);
  }
  if (parsed.data.keyless !== undefined) {
    updates.push('keyless = ?');
    values.push(parsed.data.keyless ? 1 : 0);
  }
  if (parsed.data.apiFormat !== undefined) {
    updates.push('api_format = ?');
    values.push(parsed.data.apiFormat);
  }
  if (parsed.data.stickySessionsEnabled !== undefined) {
    updates.push('sticky_sessions_enabled = ?');
    values.push(parsed.data.stickySessionsEnabled ? 1 : 0);
  }

  if (parsed.data.slug !== undefined) {
    const newSlug = parsed.data.slug;
    if (newSlug !== slug) {
      // Check for conflict with an existing non-archived provider.
      const conflict = db.prepare('SELECT 1 FROM custom_providers WHERE slug = ? AND archived = 0').get(newSlug);
      if (conflict) {
        res.status(409).json({ error: { message: `slug '${newSlug}' is already in use by an active provider` } });
        return;
      }
      // Cascade the slug change to all dependent tables.
      const tx = db.transaction(() => {
        updates.push('slug = ?');
        values.push(newSlug);
        db.prepare('UPDATE api_keys SET platform = ? WHERE platform = ?').run(newSlug, slug);
        db.prepare('UPDATE models SET platform = ? WHERE platform = ?').run(newSlug, slug);
        db.prepare('UPDATE requests SET platform = ? WHERE platform = ?').run(newSlug, slug);
      });
      tx();
      slug = newSlug;
    }
  }

  if (updates.length === 0) {
    res.json({ success: true, slug });
    return;
  }

  values.push(slug);
  db.prepare(`UPDATE custom_providers SET ${updates.join(', ')} WHERE slug = ?`).run(...values);

  res.json({ success: true, slug });
});
// Analytics retains historical request data. Re-adding the same slug+bare_url
// revives the provider from the archive.
customRouter.delete('/api/custom-providers/:slug', (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT archived FROM custom_providers WHERE slug = ?').get(slug) as { archived: number } | undefined;
  if (!existing) {
    res.status(404).json({ error: { message: `provider '${slug}' not found` } });
    return;
  }
  if (existing.archived === 1) {
    res.status(400).json({ error: { message: `provider '${slug}' is already archived` } });
    return;
  }

  // Soft-delete: remove from fallback chain, disable keys and models,
  // archive the provider row. Analytics retains historical request data.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)').run(slug);
    db.prepare('UPDATE custom_providers SET archived = 1 WHERE slug = ?').run(slug);
    db.prepare('UPDATE api_keys SET enabled = 0 WHERE platform = ?').run(slug);
    db.prepare('UPDATE models SET enabled = 0 WHERE platform = ?').run(slug);
  });
  tx();

  clearPlatformCaches(slug);
  res.json({ success: true, archived: true });
});


// Trigger model auto-discovery for an existing provider.
customRouter.post('/api/custom-providers/:slug/sync-models', async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  const autoEnableModels = req.query.autoEnable === 'true';

  // Resolve base URL: custom providers have it in the DB; built-in providers
  // expose it via BaseProvider.baseUrl.
  const customRow = getDb().prepare('SELECT base_url FROM custom_providers WHERE slug = ?').get(slug) as { base_url: string } | undefined;
  let baseUrl: string | undefined;
  if (customRow) {
    baseUrl = customRow.base_url;
  } else if (hasProvider(slug as any)) {
    const provider = buildProviderFor(slug);
    baseUrl = provider?.baseUrl;
  }
  if (!baseUrl) {
    res.status(404).json({ error: { message: `provider '${slug}' not found or does not support model discovery` } });
    return;
  }

  const result = await syncModelsFromProvider(baseUrl, slug, autoEnableModels);

  res.json({ success: true, slug, fetched: result.fetched, error: result.error });
});

// ── Models ─────────────────────────────────────────────────────────────

// List all models for a custom provider. Same shape as /api/models entries
// (so the dashboard can render them in the same list as built-in models).
customRouter.get('/api/custom-providers/:slug/models', (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  const db = getDb();
  if (!isKnownProvider(slug)) {
    res.status(404).json({ error: { message: `provider '${slug}' not found` } });
    return;
  }

  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled AS fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.platform = ?
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all(slug) as Array<any>;

  res.json(models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
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
  })));
});

// Add a model to a custom provider. Creates the model row and appends it
// to the fallback chain at the lowest priority (so it routes after the
// existing chain until the user reorders in the Fallback page).
customRouter.post('/api/custom-providers/:slug/models', (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  const parsed = createModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  if (!isKnownProvider(slug)) {
    res.status(404).json({ error: { message: `provider '${slug}' not found` } });
    return;
  }

  const provRow = db.prepare('SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM custom_providers WHERE slug = ?').get(slug) as { rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null } | undefined;
  // Built-in providers return null provRow — use MODEL_DEFAULTS for limits.
  const d = parsed.data;
  const modelId = d.modelId.trim();
  const displayName = d.displayName.trim();
  // If the model exists but is disabled (e.g. from an archived provider),
  // revive it instead of returning 409.
  const dup = db.prepare('SELECT id, enabled FROM models WHERE platform = ? AND model_id = ?').get(slug, modelId) as { id: number; enabled: number } | undefined;
  if (dup) {
    if (dup.enabled === 1) {
      res.status(409).json({ error: { message: `model '${modelId}' already exists on provider '${slug}'` } });
      return;
    }
    // Revive: re-enable and update metadata.
    db.prepare(`
      UPDATE models SET enabled = 1, display_name = ? WHERE id = ?
    `).run(displayName, dup.id);
    // Ensure in fallback chain.
    const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(dup.id);
    if (!inChain) {
      const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(dup.id, max.m + 1);
    }
    res.status(200).json({
      success: true, id: dup.id, platform: slug, modelId, displayName, revived: true,
    });
    return;
  }
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools, max_output_tokens, key_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
    `).run(
      slug, modelId, displayName,
      d.intelligenceRank ?? MODEL_DEFAULTS.intelligenceRank,
      d.speedRank ?? MODEL_DEFAULTS.speedRank,
      d.sizeLabel ?? MODEL_DEFAULTS.sizeLabel,
      d.rpmLimit ?? provRow?.rpm_limit ?? MODEL_DEFAULTS.rpmLimit,
      d.rpdLimit ?? provRow?.rpd_limit ?? MODEL_DEFAULTS.rpdLimit,
      d.tpmLimit ?? provRow?.tpm_limit ?? MODEL_DEFAULTS.tpmLimit,
      d.tpdLimit ?? provRow?.tpd_limit ?? MODEL_DEFAULTS.tpdLimit,
      d.monthlyTokenBudget ?? MODEL_DEFAULTS.monthlyTokenBudget,
      d.contextWindow ?? null,
      d.supportsVision ?? MODEL_DEFAULTS.supportsVision ? 1 : 0,
      d.supportsTools ?? MODEL_DEFAULTS.supportsTools ? 1 : 0,
    );
    const modelDbId = Number(result.lastInsertRowid);
    // Append to the fallback chain if not already present.
    const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId);
    if (!inChain) {
      const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, max.m + 1);
    }
    return modelDbId;
  });
  const modelDbId = tx();
  res.status(201).json({
    success: true,
    id: modelDbId,
    platform: slug,
    modelId,
    displayName,
  });
});

// Edit any subset of a custom model. Built-in catalog rows return 400 — they
// have a separate migration path (server migrations) and should not be
// mutated through this endpoint.
customRouter.patch('/api/custom-models/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'invalid model id' } });
    return;
  }

  const parsed = updateModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT platform FROM models WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: { message: 'model not found' } });
    return;
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  const d = parsed.data;
  if (d.displayName !== undefined) { updates.push('display_name = ?'); values.push(d.displayName.trim()); }
  if (d.contextWindow !== undefined) { updates.push('context_window = ?'); values.push(d.contextWindow); }
  if (d.intelligenceRank !== undefined) { updates.push('intelligence_rank = ?'); values.push(d.intelligenceRank); }
  if (d.speedRank !== undefined) { updates.push('speed_rank = ?'); values.push(d.speedRank); }
  if (d.sizeLabel !== undefined) { updates.push('size_label = ?'); values.push(d.sizeLabel); }
  if (d.supportsTools !== undefined) { updates.push('supports_tools = ?'); values.push(d.supportsTools ? 1 : 0); }
  if (d.supportsVision !== undefined) { updates.push('supports_vision = ?'); values.push(d.supportsVision ? 1 : 0); }
  if (d.monthlyTokenBudget !== undefined) { updates.push('monthly_token_budget = ?'); values.push(d.monthlyTokenBudget); }
  if (d.rpmLimit !== undefined) { updates.push('rpm_limit = ?'); values.push(d.rpmLimit); }
  if (d.rpdLimit !== undefined) { updates.push('rpd_limit = ?'); values.push(d.rpdLimit); }
  if (d.tpmLimit !== undefined) { updates.push('tpm_limit = ?'); values.push(d.tpmLimit); }
  if (d.tpdLimit !== undefined) { updates.push('tpd_limit = ?'); values.push(d.tpdLimit); }
  if (d.maxOutputTokens !== undefined) { updates.push('max_output_tokens = ?'); values.push(d.maxOutputTokens); }
  if (d.enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(d.enabled ? 1 : 0);
  }

  if (updates.length === 0) {
    res.json({ success: true, id });
    return;
  }

  values.push(id);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    if (d.enabled === true) {
      const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(id);
      if (inChain) {
        db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(id);
      } else {
        const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
        db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, max.m + 1);
      }
    } else if (d.enabled === false) {
      db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    }
  });
  tx();
  res.json({ success: true, id });
});

// Archive a single custom model — disables it and removes from the fallback
// chain. The row stays for analytics. Use the provider DELETE to archive all
// models at once. Re-adding the model revives it.
customRouter.delete('/api/custom-models/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'invalid model id' } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT id, platform, enabled FROM models WHERE id = ?').get(id) as { id: number; platform: string; enabled: number } | undefined;
  if (!existing) {
    res.status(404).json({ error: { message: 'model not found' } });
    return;
  }
  if (existing.enabled === 0) {
    res.status(400).json({ error: { message: 'model is already archived' } });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(id);
  });
  tx();

  // Degradation engine handles cleanup via ghost eviction and success recovery.
  res.json({ success: true, id, archived: true });
});
