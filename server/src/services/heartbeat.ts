/**
 * Provider Health Heartbeat — Per-Key Edition
 *
 * Sends periodic minimal pings to each API key to proactively detect
 * unhealthy keys. Results feed the degradation engine at the model level
 * AND maintain a per-key health map so the router can prefer healthy keys.
 *
 * Activity-gated: only pings when a user request was made recently.
 * Pings every key for every enabled model in the fallback chain.
 *
 * Opt-in: disabled by default (heartbeat_enabled=false).
 */
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { buildProviderFor } from '../providers/index.js';
import { classifyError, recordFailure, recordSuccess } from './degradation.js';
import { publish } from './events.js';
import { getFeatureSetting } from './feature-settings.js';

// ── Per-key health state ─────────────────────────────────────────────────────

interface KeyHealth {
  /** 0 = healthy, higher = worse. Incremented on failure, reset on success. */
  penalty: number;
  /** Timestamp of last ping attempt (success or failure). */
  lastPingAt: number;
  /** Whether the most recent ping succeeded. */
  healthy: boolean;
  /** Last error message (if unhealthy). */
  lastError?: string;
}

const keyHealthMap = new Map<number, KeyHealth>();

/** Get current health state for a key (read-only). */
export function getKeyHealth(keyId: number): KeyHealth | undefined {
  return keyHealthMap.get(keyId);
}

/** Check whether a key is currently healthy according to heartbeat pings.
 *  When heartbeat is enabled, cold keys (never pinged) return false — they
 *  must be prewarmed first. Only keys that have been successfully pinged
 *  at least once report true.
 *  When heartbeat is disabled, cold keys are assumed healthy (backward-compat).
 */
export function isKeyHealthy(keyId: number): boolean {
  const h = keyHealthMap.get(keyId);
  // No data = cold key. If heartbeat is active it must be prewarmed first;
  // if heartbeat is disabled, assume healthy for backward compatibility.
  if (!h) return !isHeartbeatEnabled();
  return h.healthy;
}

/** Mark a key as unhealthy in the per-key health map. The key will be excluded
 *  from routing by `isKeyHealthy()` until a successful heartbeat ping restores it.
 *  No-op when heartbeat is disabled — the cooldown system handles recovery instead.
 *
 *  Called from `proxy.ts` when a request returns 429 (rate limit) or 402 (payment
 *  required). The key is evicted immediately — no retries wasted on a key that
 *  told us it's at capacity. */
export function markKeyUnhealthy(keyId: number, error?: string): void {
  if (!isHeartbeatEnabled()) return;
  const prev = keyHealthMap.get(keyId);
  keyHealthMap.set(keyId, {
    penalty: (prev?.penalty ?? 0) + 1,
    lastPingAt: Date.now(),
    healthy: false,
    lastError: error ?? 'evicted by traffic 429',
  });
}

/**
 * Check whether the heartbeat feature is enabled and active.
 * Returns false when heartbeat is disabled, meaning all keys are usable
 * without prewarming (backward-compatible mode for router.ts).
 */
export function isHeartbeatEnabled(): boolean {
  return readConfig().enabled;
}

/** Get all key health states (for dashboard/debugging). */
export function getAllKeyHealth(): Map<number, KeyHealth> {
  return new Map(keyHealthMap);
}

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

function getAutoDisableThresholdPct(): number {
  return getFeatureSetting('heartbeat_auto_disable_pct') as number;
}

/** Reset the cached config (used in tests and after settings change). */
export function resetHeartbeatConfig(): void {
  _enabled = null;
  _intervalMs = null;
  _activityWindowMs = null;
  _pingTimeoutMs = null;
  _staggerMs = null;
  keyHealthMap.clear();
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
    console.log(`[Heartbeat] Starting per-key timer (interval=${intervalMs / 1000}s)`);
    timerRef = setInterval(() => { runCycle().catch(e => console.error('[Heartbeat] Cycle error:', e)); }, intervalMs);
    timerRef.unref();

    // ── Startup prewarm: immediately fire a cycle to warm up all keys ──
    // This ensures keys are prewarmed before the first user request arrives,
    // rather than waiting for the first interval tick (default 10 min delay).
    // The activity gate is bypassed so keys are pinged even if no prior
    // user request has been recorded (startup case).
    console.log('[Heartbeat] Firing startup prewarm cycle');
    runCycle(true).catch(e => console.error('[Heartbeat] Prewarm cycle error:', e));
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

/** Trigger a full heartbeat cycle immediately, bypassing the activity gate.
 *  Equivalent to a manual prewarm — pings every enabled key for every enabled
 *  model. If a cycle is already in progress, this is a no-op (guarded by
 *  cycleInProgress). Useful for admin endpoints that need to force a health
 *  refresh after bulk key changes. */
export async function pokeAllKeys(): Promise<{ poked: number; skipped: boolean }> {
  const poked = await runCycle(true);
  return { poked, skipped: poked === 0 };
}

/** Ping a single key immediately and update its health in keyHealthMap.
 *  Returns true if the key is healthy after the ping. This is the on-demand
 *  counterpart to the periodic cycle — it prewarms a newly-added key without
 *  waiting for the next scheduled tick.
 *
 *  Does NOT block on cycleInProgress — a single-key ping runs independently
 *  of the cycle state. When heartbeat is disabled, returns true immediately
 *  (backward compat: all keys assumed healthy). */
export async function pokeKey(keyId: number): Promise<boolean> {
  if (!isHeartbeatEnabled()) return true;

  const db = getDb();
  const keyRow = db.prepare(
    "SELECT * FROM api_keys WHERE id = ? AND enabled = 1"
  ).get(keyId) as any | undefined;
  if (!keyRow) return false;

  // Get the highest-priority model for this key's platform
  const model = db.prepare(`
    SELECT m.id AS model_db_id, m.model_id
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
    WHERE fc.enabled = 1 AND m.platform = ?
    ORDER BY fc.priority ASC
    LIMIT 1
  `).get(keyRow.platform) as { model_db_id: number; model_id: string } | undefined;
  if (!model) return false;

  const { pingTimeoutMs } = readConfig();
  await pingKey(keyRow.platform, model.model_db_id, model.model_id, keyRow, pingTimeoutMs);
  return isKeyHealthy(keyId);
}

// ── Internal: cycle logic ───────────────────────────────────────────────────

async function runCycle(skipGate = false): Promise<number> {
  if (cycleInProgress) return 0;
  cycleInProgress = true;

  try {
    const now = Date.now();
    const { activityWindowMs, staggerMs, pingTimeoutMs } = readConfig();

    // ── Activity gate ──
    // The gate is bypassed for the startup prewarm cycle (skipGate=true)
    // so that keys are warmed up immediately on startup even when no prior
    // user request has been recorded.
    if (!skipGate && (lastActivityAt === 0 || now - lastActivityAt > activityWindowMs)) {
      publish({
        type: 'heartbeat.cycle_skipped',
        reason: 'activity_gate',
        lastActivityAgeMs: lastActivityAt === 0 ? -1 : now - lastActivityAt,
        at: now,
      });
      return 0;
    }

    // ── Get enabled models from the fallback chain ──
    // Order by priority so we deterministically use the highest-priority model
    // on each platform to ping all of its keys. Without ordering, a key might
    // randomly be pinged with a restricted model on some cycles (causing
    // 403/404 failures) and a standard model on others.
    const db = getDb();
    const models = db.prepare(`
      SELECT m.platform, m.id AS model_db_id, m.model_id, MIN(fc.priority) AS priority
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
      WHERE fc.enabled = 1
      GROUP BY m.platform, m.id, m.model_id
      ORDER BY priority ASC
    `).all() as Array<{ platform: string; model_db_id: number; model_id: string }>;

    if (models.length === 0) return 0;

    // ── Collect all keys for each platform+model combo ──
    const pingTasks: Array<{
      platform: string;
      modelDbId: number;
      modelId: string;
      key: any;
    }> = [];

    const seenKeys = new Set<number>();
    const pingedModels = new Set<string>(); // "platform:modelDbId:modelId" dedup
    for (const model of models) {
      const keys = db.prepare(
        "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown', 'error')"
      ).all(model.platform) as any[];

      if (keys.length > 0) {
        pingedModels.add(`${model.platform}:${model.model_db_id}:${model.model_id}`);
      }

      for (const key of keys) {
        // Ping each key only once per cycle even if it appears for multiple models
        if (seenKeys.has(key.id)) continue;
        seenKeys.add(key.id);
        pingTasks.push({
          platform: model.platform,
          modelDbId: model.model_db_id,
          modelId: model.model_id,
          key,
        });
      }
    }

    // ── Group by provider and ping concurrently across providers ──
    // Different providers are pinged in parallel, but within each provider,
    // keys are pinged sequentially (with optional stagger) to avoid overwhelming
    // the same provider with a burst of concurrent requests (DDoS).
    const groupedByPlatform = new Map<string, typeof pingTasks>();
    for (const task of pingTasks) {
      const group = groupedByPlatform.get(task.platform) ?? [];
      group.push(task);
      groupedByPlatform.set(task.platform, group);
    }

    // Sort each group by modelDbId so same-model keys are pinged consecutively
    for (const [, tasks] of groupedByPlatform) {
      tasks.sort((a, b) => a.modelDbId - b.modelDbId);
    }

    // Run all provider groups concurrently, but within each group ping sequentially
    await Promise.all(Array.from(groupedByPlatform.entries()).map(async ([platform, tasks]) => {
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        try {
          await pingKey(task.platform, task.modelDbId, task.modelId, task.key, pingTimeoutMs);
        } catch (e) {
          console.error(`[Heartbeat] Ping error for key#${task.key.id} on ${task.platform}/${task.modelId}:`, e);
        }
        if (staggerMs > 0 && i < tasks.length - 1) {
          await sleep(staggerMs);
        }
      }
    }));

    // ── Auto-disable evaluation ──
    // After all pings complete, evaluate each pinged model's key health.
    // If ≥ threshold % of keys are unhealthy, disable the model.
    for (const key of pingedModels) {
      const parts = key.split(':');
      const platform = parts[0];
      const modelDbIdStr = parts[1];
      const modelId = parts.slice(2).join(':'); // model IDs may contain colons (e.g. qwen3-coder:480b)
      const modelDbId = parseInt(modelDbIdStr, 10);
      const result = evaluateAutoDisable(db, modelDbId, platform, modelId);
      if (result?.disabled) {
        publish({
          type: 'heartbeat.auto_disable',
          provider: result.platform,
          model: result.modelId,
          modelDbId: result.modelDbId,
          totalKeys: result.totalKeys,
          unhealthyKeys: result.unhealthyKeys,
          threshold: getAutoDisableThresholdPct(),
          at: Date.now(),
        });
      }
    }
    return pingTasks.length;
  } finally {
    cycleInProgress = false;
  }
}

// ── Internal: ping a single key ─────────────────────────────────────────────

async function pingKey(platform: string, modelDbId: number, modelId: string, keyRow: any, pingTimeoutMs: number): Promise<void> {
  const provider = buildProviderFor(platform);
  if (!provider) return;

  let decryptedKey: string;
  try {
    decryptedKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch {
    // Decrypt failure is permanent — mark key unhealthy so the router
    // deprioritizes it until the health checker disables it (enabled=0).
    keyHealthMap.set(keyRow.id, {
      penalty: 0,
      lastPingAt: Date.now(),
      healthy: false,
      lastError: 'decrypt failed',
    });
    return;
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

    // Success — mark key healthy and reduce model-level degradation
    keyHealthMap.set(keyRow.id, {
      penalty: 0,
      lastPingAt: Date.now(),
      healthy: true,
    });
    recordSuccess(modelDbId);
    publish({
      type: 'heartbeat.ping',
      provider: platform,
      model: modelId,
      keyId: keyRow.id,
      success: true,
      latencyMs: Date.now() - start,
      at: Date.now(),
    });
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const tier = classifyError(err);

    // Model-specific errors (403/404) mean the key is valid but this model
    // isn't accessible on its tier. Don't poison the key's global health —
    // only genuine failures (5xx, timeout, 429) should penalize the key.
    // The regex fallback is gated on non-5xx status to avoid matching
    // e.g. a 500 whose message happens to contain "forbidden".
    const status = err?.status;
    const isModelError = status === 403 || status === 404
      || ((!status || status < 500)
        && /forbidden|not found|no endpoints found/i.test(err?.message ?? ''));

    if (!isModelError) {
      const prev = keyHealthMap.get(keyRow.id);
      const newPenalty = (prev?.penalty ?? 0) + 1;
      keyHealthMap.set(keyRow.id, {
        penalty: newPenalty,
        lastPingAt: Date.now(),
        healthy: false,
        lastError: (err?.message ?? 'unknown').slice(0, 120),
      });
    }

    // Only record model-level degradation for retryable errors (5xx, 429)
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
      keyId: keyRow.id,
      success: false,
      latencyMs,
      error: (err?.message ?? 'unknown').slice(0, 120),
      at: Date.now(),
    });
  }
}

// ── Auto-disable evaluation ──────────────────────────────────────────────

interface AutoDisableResult {
  modelDbId: number;
  platform: string;
  modelId: string;
  totalKeys: number;
  unhealthyKeys: number;
  disabled: boolean;
}

function evaluateAutoDisable(
  db: ReturnType<typeof getDb>,
  modelDbId: number,
  platform: string,
  modelId: string,
): AutoDisableResult | null {
  const threshold = getAutoDisableThresholdPct();
  if (threshold === 0) return null; // Feature disabled by configuration
  const allKeys = db.prepare(
    "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown', 'error')"
  ).all(platform) as Array<{ id: number }>;

  const total = allKeys.length;
  if (total === 0) return null;

  let unhealthy = 0;
  for (const k of allKeys) {
    const health = keyHealthMap.get(k.id);
    if (health && !health.healthy) unhealthy++;
    else if (!health) unhealthy++; // Cold key = assumed unhealthy
  }

  const pct = (unhealthy / total) * 100;
  if (pct < threshold) return null;

  const info = db.prepare(
    "SELECT enabled FROM models WHERE id = ?"
  ).get(modelDbId) as { enabled: number } | undefined;

  if (!info || info.enabled === 0) {
    return { modelDbId, platform, modelId, totalKeys: total, unhealthyKeys: unhealthy, disabled: false };
  }

  // Disable the model and mark it as auto-disabled
  db.prepare(
    "UPDATE models SET enabled = 0, auto_disabled_at = datetime('now') WHERE id = ?"
  ).run(modelDbId);

  return { modelDbId, platform, modelId, totalKeys: total, unhealthyKeys: unhealthy, disabled: true };
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
