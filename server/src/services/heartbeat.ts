/**
 * Provider Health Heartbeat
 *
 * Sends periodic minimal pings to each enabled provider to proactively
 * detect outages. Results feed the degradation engine so the bandit
 * scorer already knows provider health before the first user request.
 *
 * Activity-gated: only pings when a user request was made recently.
 * One ping per provider per cycle to minimize upstream channel consumption.
 *
 * Opt-in: disabled by default (heartbeat_enabled=false).
 */
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { buildProviderFor } from '../providers/index.js';
import { isOnCooldown } from './ratelimit.js';
import { isExhausted } from './key-exhaustion.js';
import { classifyError, recordFailure, recordSuccess, getPenalty } from './degradation.js';
import { publish } from './events.js';
import { getFeatureSetting } from './feature-settings.js';

// ── Configuration (lazy-initialized from feature-settings on first use) ─────

let _enabled: boolean | null = null;
let _intervalMs: number | null = null;
let _activityWindowMs: number | null = null;
let _pingTimeoutMs: number | null = null;
let _staggerMs: number | null = null;

function readConfig() {
  if (_enabled === null) {
    _enabled = getFeatureSetting('heartbeat_enabled') as boolean;
    _intervalMs = (getFeatureSetting('heartbeat_interval_min') as number) * 60 * 1000;
    _activityWindowMs = (getFeatureSetting('heartbeat_activity_window_min') as number) * 60 * 1000;
    _pingTimeoutMs = getFeatureSetting('heartbeat_timeout_ms') as number;
    _staggerMs = getFeatureSetting('heartbeat_stagger_ms') as number;
  }
  return { enabled: _enabled, intervalMs: _intervalMs!, activityWindowMs: _activityWindowMs!, pingTimeoutMs: _pingTimeoutMs!, staggerMs: _staggerMs! };
}

/** Reset the cached config (used in tests and after settings change). */
export function resetHeartbeatConfig(): void {
  _enabled = null;
  _intervalMs = null;
  _activityWindowMs = null;
  _pingTimeoutMs = null;
  _staggerMs = null;
}

// ── Module-level state ──────────────────────────────────────────────────────

let timerRef: ReturnType<typeof setInterval> | null = null;
let lastActivityAt = 0;
let cycleInProgress = false;

// ── Public API ──────────────────────────────────────────────────────────────

/** Called from proxy.ts on every /chat/completions request (success or failure). O(1). */
export function recordActivity(): void {
  lastActivityAt = Date.now();
}

/** Called from server startup to begin the timer. No-op when disabled. */
export function startHeartbeat(): void {
  try {
    const { enabled, intervalMs } = readConfig();
    if (!enabled) {
      console.log('[Heartbeat] Disabled — no timer started');
      return;
    }
    if (timerRef) return; // already running
    console.log(`[Heartbeat] Starting timer (interval=${intervalMs / 1000}s)`);
    timerRef = setInterval(() => { runCycle().catch(e => console.error('[Heartbeat] Cycle error:', e)); }, intervalMs);
    timerRef.unref();
  } catch (e) {
    // DB not ready or config read failed — log and skip
    console.error('[Heartbeat] Failed to start:', e);
  }
}

/** Called from graceful shutdown. Safe to call even if never started. */
export function stopHeartbeat(): void {
  if (timerRef) {
    clearInterval(timerRef);
    timerRef = null;
    console.log('[Heartbeat] Timer stopped');
  }
}

// ── Internal: cycle logic ───────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  if (cycleInProgress) return;
  cycleInProgress = true;

  try {
    const now = Date.now();
    const { activityWindowMs, staggerMs, pingTimeoutMs } = readConfig();

    // ── Activity gate ──
    if (lastActivityAt === 0 || now - lastActivityAt > activityWindowMs) {
      publish({
        type: 'heartbeat.cycle_skipped',
        reason: 'activity_gate',
        lastActivityAgeMs: lastActivityAt === 0 ? -1 : now - lastActivityAt,
        at: now,
      });
      return;
    }

    // ── Get platforms from enabled fallback chain ──
    const db = getDb();
    const platforms = db.prepare(`
      SELECT DISTINCT m.platform, m.id AS model_db_id, m.model_id
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
      WHERE fc.enabled = 1
    `).all() as Array<{ platform: string; model_db_id: number; model_id: string }>;

    if (platforms.length === 0) return;

    // Group by platform, pick the healthiest model per platform (lowest penalty)
    const byPlatform = new Map<string, { modelDbId: number; modelId: string; penalty: number }>();
    for (const row of platforms) {
      const existing = byPlatform.get(row.platform);
      const penalty = getPenalty(row.model_db_id);
      if (!existing || penalty < existing.penalty) {
        byPlatform.set(row.platform, {
          modelDbId: row.model_db_id,
          modelId: row.model_id,
          penalty,
        });
      }
    }

    // ── Ping each provider (staggered) ──
    for (const [platform, model] of byPlatform) {
      try {
        await pingProvider(platform, model.modelDbId, model.modelId, pingTimeoutMs);
      } catch (e) {
        console.error(`[Heartbeat] Ping error for ${platform}/${model.modelId}:`, e);
      }
      if (staggerMs > 0 && platform !== [...byPlatform.keys()].at(-1)) {
        await sleep(staggerMs);
      }
    }
  } finally {
    cycleInProgress = false;
  }
}

// ── Internal: ping a single provider ────────────────────────────────────────

async function pingProvider(platform: string, modelDbId: number, modelId: string, pingTimeoutMs: number): Promise<void> {
  const db = getDb();

  // Find a healthy, non-cooldown, non-exhausted key
  const keys = db.prepare(
    "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all(platform) as any[];

  let targetKey: any = null;
  for (const key of keys) {
    if (!isOnCooldown(platform, modelId, key.id) && !isExhausted(key.id)) {
      targetKey = key;
      break;
    }
  }

  if (!targetKey) return; // no eligible key — skip silently

  const provider = buildProviderFor(platform);
  if (!provider) return;

  let decryptedKey: string;
  try {
    decryptedKey = decrypt(targetKey.encrypted_key, targetKey.iv, targetKey.auth_tag);
  } catch {
    return; // decryption failed — skip, don't penalize
  }

  const start = Date.now();
  try {
    await withTimeout(
      provider.chatCompletion(
        decryptedKey,
        [{ role: 'user', content: 'hi' }],
        modelId,
        { max_tokens: 5, temperature: 0 },
      ),
      pingTimeoutMs,
    );

    // Success — reduce degradation penalty
    recordSuccess(modelDbId);
    publish({
      type: 'heartbeat.ping',
      provider: platform,
      model: modelId,
      success: true,
      latencyMs: Date.now() - start,
      at: Date.now(),
    });
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const tier = classifyError(err);

    // Only record degradation for retryable errors (5xx, 429)
    // Non-retryable (401, 403, 404) are config issues, not health signals
    if (tier === 'major') {
      recordFailure(modelDbId, 'major');
    } else if (tier === 'minor') {
      recordFailure(modelDbId, 'minor');
    }
    // tier === null → non-retryable config error, log but don't penalize

    publish({
      type: 'heartbeat.ping',
      provider: platform,
      model: modelId,
      success: false,
      latencyMs,
      error: (err?.message ?? 'unknown').slice(0, 120),
      at: Date.now(),
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`heartbeat ping timed out after ${ms}ms`)),
      ms,
    );
    promise
      .then(v => { clearTimeout(timer); resolve(v); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
