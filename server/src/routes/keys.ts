import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getProvider, buildProviderFor } from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { pokeKey } from '../services/heartbeat.js';

export const keysRouter = Router();

// Active built-in providers — must match providers/index.ts registrations +
// shared/types.ts Platform. Custom providers are NOT in this list: they are
// created via POST /api/custom-providers and have their own base URL, and their
// keys (if any) are added by hitting POST /api/keys with the custom slug.
// Moonshot and MiniMax direct integrations were dropped in V4. HuggingFace
// was dropped in V4 and re-added in V13 via the router.huggingface.co route.
// SambaNova was dropped in V23 (free tier permanently retired).
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu',
  'ollama', 'kilo', 'pollinations', 'llm7', 'huggingface',
  'opencode', 'ovh', 'commandcode',
] as const;

// `key` is optional so keyless providers (Kilo's anonymous gateway) can be added
// without one; the handler enforces a non-empty key for everyone else.
// Platform accepts any built-in (PLATFORMS) OR a custom provider slug; the
// handler resolves it to confirm it exists.
const addKeySchema = z.object({
  platform: z.string().min(1, 'platform is required'),
  key: z.string().optional(),
  label: z.string().optional(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
}).refine(data => data.enabled !== undefined || data.label !== undefined, {
  message: 'At least one of enabled or label must be provided',
});

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      baseUrl: row.base_url ?? null,
      status: row.status,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, label } = parsed.data;

  // Resolve platform → provider. Built-ins come from the registry; custom
  // slugs come from custom_providers (and their base URL gets stamped on the
  // key row so the denormalized schema stays consistent with the new
  // canonical source of truth).
  const db = getDb();
  const provider = getProvider(platform as any) ?? buildProviderFor(platform);
  if (!provider) {
    res.status(400).json({ error: { message: `Unknown platform '${platform}'` } });
    return;
  }
  const isKeyless = provider.keyless === true;
  const rawKey = parsed.data.key?.trim() ?? '';

  if (!isKeyless && !rawKey) {
    res.status(400).json({ error: { message: 'key is required' } });
    return;
  }

  // Keyless providers (Kilo anon) store a sentinel so routing sees the platform
  // as configured; the provider omits the auth header on outgoing calls.
  const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

  // For custom slugs, look up the base URL so the key row carries it
  // (denormalized — custom_providers is the source of truth, but having
  // base_url on api_keys keeps older queries from breaking).
  const baseUrl = (provider as { baseUrl?: string }).baseUrl ?? null;

  // A keyless provider needs only one sentinel row — re-enable an existing one
  // instead of piling up duplicates each time the user clicks "Add".
  if (isKeyless) {
    const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
      res.status(200).json({
        id: existing.id,
        platform,
        label: label ?? '',
        maskedKey: maskKey(keyToStore),
        status: 'unknown',
        enabled: true,
      });
      return;
    }
  }

  const { encrypted, iv, authTag } = encrypt(keyToStore);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1, ?)
  `).run(platform, label ?? '', encrypted, iv, authTag, baseUrl);

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    maskedKey: maskKey(keyToStore),
    status: 'unknown',
    enabled: true,
  });
  // Fire-and-forget: warm up the key immediately via heartbeat
  pokeKey(Number(result.lastInsertRowid)).catch(() => {});
});


// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  // Custom models are owned by their custom_providers row, not by a key — so
  // deleting a key never orphans its models. (The migration V23 moved the
  // cascade from here to DELETE /api/custom-providers/:slug.)
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  });
  remove();

  res.json({ success: true });
});

// Toggle all keys for a platform. Accepts built-in platforms OR a custom
// provider slug — for the latter, the slug is verified against custom_providers.
keysRouter.patch('/platform/:platform', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    const db = getDb();
    const exists = db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(platform);
    if (!exists) {
      res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
      return;
    }
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);

  // OpenRouter / OpenCode enforcement: when toggling either ON, disable any
  // non-free models so only free-tier models remain routable.
  // SQL LIKE is case-insensitive in SQLite, so '%free%' matches Free/FREE/etc.
  let disabledNonFree = 0;
  if ((platform === 'openrouter' || platform === 'opencode') && enabled) {
    const disableResult = db.prepare(`
      UPDATE models SET enabled = 0
      WHERE platform = ?
        AND enabled = 1
        AND model_id NOT LIKE '%free%'
    `).run(platform);
    disabledNonFree = disableResult.changes;
  }

  res.json({ success: true, enabled, updatedKeys: result.changes, disabledNonFreeModels: disabledNonFree });
});

// Update key (toggle enable/disable or edit label)
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label } = parsed.data;
  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(enabled ? 1 : 0);
  }
  if (label !== undefined) {
    updates.push('label = ?');
    values.push(label);
  }

  values.push(id);

  const db = getDb();
  const result = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const response: Record<string, unknown> = { success: true };
  if (enabled !== undefined) response.enabled = enabled;
  if (label !== undefined) response.label = label;
  res.json(response);
});
