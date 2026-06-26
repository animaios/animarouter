/**
 * Per-key exhaustion tracking.
 *
 * When a key fails 3 consecutive retries it is marked "exhausted" for the
 * current model. Keys are cycled in exhaustion order (earliest first) so the
 * key that has had the longest time to recover gets tried first. A single
 * successful request clears the exhaustion; the key can be exhausted again
 * later (re-entering at the end of the queue).
 *
 * State is in-memory for speed and persists across restarts via the existing
 * rate_limit_cooldowns table (any non-expired cooldown implies exhaustion).
 * On startup we rebuild the in-memory Map from that table.
 *
 * The map key is a composite `${keyId}:${modelId}` string so that a key can
 * be independently exhausted for multiple models without overwrites.
 */

import { getDb } from '../db/index.js';
import { clearCooldownHits } from './ratelimit.js';

/** Composite key for the exhaustion map: `${keyId}:${modelId}` */
function mkKey(keyId: number, modelId: string): string {
  return `${keyId}:${modelId}`;
}

// "keyId:modelId" → { exhaustedAt (ms timestamp), provider slug, modelId }
const exhaustionMap = new Map<string, { exhaustedAt: number; provider: string; modelId: string }>();

/** Rebuild the in-memory exhaustion map from persistent cooldowns on startup. */
export function rebuildExhaustionFromDB(): void {
  exhaustionMap.clear();
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT key_id, platform, model_id, expires_at_ms
    FROM rate_limit_cooldowns
    WHERE expires_at_ms > ?
  `).all(now) as Array<{ key_id: number; platform: string; model_id: string; expires_at_ms: number }>;

  for (const row of rows) {
    // Estimate exhaustion time from expiry: a 90s cooldown means exhausted ~90s ago;
    // a 24h cooldown means exhausted ~24h ago. Approximate by assuming default 90s.
    const estimatedExhaustedAt = Math.min(row.expires_at_ms - 90_000, now);
    exhaustionMap.set(mkKey(row.key_id, row.model_id), {
      exhaustedAt: estimatedExhaustedAt > 0 ? estimatedExhaustedAt : now,
      provider: row.platform,
      modelId: row.model_id,
    });
  }
}

/** Mark a key as exhausted for a specific provider+model. */
export function markExhausted(keyId: number, provider: string, modelId: string): void {
  exhaustionMap.set(mkKey(keyId, modelId), { exhaustedAt: Date.now(), provider, modelId });
}

/** Clear exhaustion — called when a key successfully handles a request. */
export function clearExhausted(keyId: number, modelId: string): void {
  exhaustionMap.delete(mkKey(keyId, modelId));
  // Also remove any persisted cooldown for this key so a restart
  // doesn't resurrect a stale exhaustion.
  const db = getDb();
  db.prepare('DELETE FROM rate_limit_cooldowns WHERE key_id = ? AND model_id = ?').run(keyId, modelId);
}

/**
 * Check whether a key is currently marked exhausted.
 *
 * When `modelId` is provided, the check is model-aware — a key exhausted
 * for one model is NOT considered exhausted for another model, allowing
 * fast-fail to accumulate failures across models sharing the same key.
 * When omitted, checks across all models (legacy behavior).
 */
export function isExhausted(keyId: number, modelId?: string): boolean {
  if (modelId === undefined) {
    return [...exhaustionMap.keys()].some(k => k.startsWith(`${keyId}:`));
  }
  return exhaustionMap.has(mkKey(keyId, modelId));
}

/**
 * Get all exhausted keys for a given provider, sorted by exhaustion time
 * ascending (earliest exhausted first). Excludes keys that have naturally
 * expired from the in-memory map.
 */
export function getExhaustedKeysForProvider(provider: string): Array<{ keyId: number; exhaustedAt: number; modelId: string }> {
  const result: Array<{ keyId: number; exhaustedAt: number; modelId: string }> = [];
  for (const [compositeKey, info] of exhaustionMap) {
    if (info.provider === provider) {
      const keyId = Number(compositeKey.split(':')[0]);
      result.push({ keyId, exhaustedAt: info.exhaustedAt, modelId: info.modelId });
    }
  }
  result.sort((a, b) => a.exhaustedAt - b.exhaustedAt);
  return result;
}

/**
 * Same as getExhaustedKeysForProvider but scoped to a specific model.
 */
export function getExhaustedKeysForModel(provider: string, modelId: string): Array<{ keyId: number; exhaustedAt: number }> {
  const result: Array<{ keyId: number; exhaustedAt: number }> = [];
  for (const [compositeKey, info] of exhaustionMap) {
    if (info.provider === provider && info.modelId === modelId) {
      const keyId = Number(compositeKey.split(':')[0]);
      result.push({ keyId, exhaustedAt: info.exhaustedAt });
    }
  }
  result.sort((a, b) => a.exhaustedAt - b.exhaustedAt);
  return result;
}

/** Check if all enabled keys for a provider+model combo are exhausted. */
export function areAllKeysExhausted(provider: string, modelId: string): boolean {
  const db = getDb();
  const keys = db.prepare(
    "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown', 'error')"
  ).all(provider) as Array<{ id: number }>;

  if (keys.length === 0) return true;
  return keys.every(k => exhaustionMap.has(mkKey(k.id, modelId)));
}

/** Check if all enabled keys for a provider (across all models) are exhausted. */
export function areAllProviderKeysExhausted(provider: string): boolean {
  const db = getDb();
  const keys = db.prepare(
    "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown', 'error')"
  ).all(provider) as Array<{ id: number }>;

  if (keys.length === 0) return true;
  return keys.every(k => [...exhaustionMap.keys()].some(ek => ek.startsWith(`${k.id}:`)));
}

/** Remove exhaustion entries whose associated cooldown has expired in the DB.
 *  Called periodically to prevent stale entries from accumulating indefinitely. */
export function sweepStaleExhaustion(): number {
  const db = getDb();
  const now = Date.now();
  let swept = 0;
  for (const [compositeKey, info] of exhaustionMap) {
    const keyId = Number(compositeKey.split(':')[0]);
    const row = db.prepare(`
      SELECT 1 FROM rate_limit_cooldowns
      WHERE key_id = ? AND model_id = ? AND expires_at_ms > ?
    `).get(keyId, info.modelId, now) as unknown;
    if (!row) {
      exhaustionMap.delete(compositeKey);
      clearCooldownHits(info.provider, info.modelId, keyId);
      swept++;
    }
  }
  return swept;
}

// ── Sweep interval lifecycle ─────────────────────────────────────────────────
let sweepTimerRef: ReturnType<typeof setInterval> | null = null;

/** Start the periodic exhaustion sweep. Call once at server startup. */
export function startExhaustionSweep(): void {
  if (sweepTimerRef) return;
  sweepTimerRef = setInterval(() => {
    const swept = sweepStaleExhaustion();
    if (swept > 0) console.log(`[Exhaustion] Swept ${swept} stale entries`);
  }, 60_000);
  sweepTimerRef.unref();
}

/** Stop the periodic exhaustion sweep. Call on graceful shutdown. */
export function stopExhaustionSweep(): void {
  if (sweepTimerRef) {
    clearInterval(sweepTimerRef);
    sweepTimerRef = null;
  }
}
