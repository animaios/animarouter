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

/** Check whether a key is currently healthy according to heartbeat pings. */
export function isKeyHealthy(keyId: number): boolean {
  const h = keyHealthMap.get(keyId);
  // No data = assume healthy (never pinged yet)
  return h ? h.healthy : true;
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
    console.log(`[Heartbeat] Starting per-key timer (interval=${intervalMs / 1000}s)`);
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

    if (models.length === 0) return;

    // ── Collect all keys for each platform+model combo ──
    const pingTasks: Array<{
      platform: string;
      modelDbId: number;
      modelId: string;
      key: any;
    }> = [];

    const seenKeys = new Set<number>();
    for (const model of models) {
      const keys = db.prepare(
        "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown', 'error')"
      ).all(model.platform) as any[];

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

    // ── Ping each key (staggered) ──
    for (let i = 0; i < pingTasks.length; i++) {
      const task = pingTasks[i];
      try {
        await pingKey(task.platform, task.modelDbId, task.modelId, task.key, pingTimeoutMs);
      } catch (e) {
        console.error(`[Heartbeat] Ping error for key#${task.key.id} on ${task.platform}/${task.modelId}:`, e);
      }
      if (staggerMs > 0 && i < pingTasks.length - 1) {
        await sleep(staggerMs);
      }
    }
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
    const isModelError = err?.status === 403 || err?.status === 404
      || /forbidden|not found|no endpoints found/i.test(err?.message ?? '');

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
