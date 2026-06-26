/**
 * Provider Health Heartbeat — Per-Key-Per-Model Edition
 *
 * Sends periodic minimal pings to each API key to proactively detect
 * unhealthy keys. Results feed the degradation engine at the model level
 * AND maintain a per-key-per-model health map so the router can prefer
 * healthy keys on a per-model basis.
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
import { publishDeduped as publish } from './events.js';
import { getFeatureSetting } from './feature-settings.js';

// ──────────────────────────────────────────────────────────────────────
// Per-key-per-model health state
// ──────────────────────────────────────────────────────────────────────

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

/** Composite key for per-key-per-model health map: `${keyId}:${modelId}` */
export function healthKey(keyId: number, modelId: string): string {
  return `${keyId}:${modelId}`;
}

export const keyHealthMap = new Map<string, KeyHealth>();

/** Get current health state for a key+model combo (read-only). */
export function getKeyHealth(keyId: number, modelId?: string): KeyHealth | undefined {
  if (modelId) {
    return keyHealthMap.get(healthKey(keyId, modelId));
  }
  // No model specified: return first entry for this keyId
  const keyIdStr = String(keyId);
  for (const [key, health] of keyHealthMap) {
    if (key.split(':')[0] === keyIdStr) return health;
  }
  return undefined;
}

/** Check whether a key is currently healthy according to heartbeat pings.
 *  - If modelId is provided: check health for that specific key+model combo.
 *  - If no modelId: return true if key is healthy on ANY model (backward compat).
 *  - When heartbeat is enabled, cold keys (never pinged) return false — they
 *    must be prewarmed first. Only keys that have been successfully pinged
 *    at least once report true.
 *  - When heartbeat is disabled, cold keys are assumed healthy (backward-compat).
 */
export function isKeyHealthy(keyId: number, modelId?: string): boolean {
  if (modelId) {
    const h = keyHealthMap.get(healthKey(keyId, modelId));
    if (!h) return !isHeartbeatEnabled(); // cold entry
    return h.healthy;
  }
  // No model specified: healthy if ANY model is healthy
  return isKeyHealthyOnAnyModel(keyId);
}

/** Internal helper: check if a key is healthy on ANY model. */
function isKeyHealthyOnAnyModel(keyId: number): boolean {
  const keyIdStr = String(keyId);
  for (const [key, health] of keyHealthMap) {
    // Exact match: key must be "${keyId}:${modelId}" (split by ":" first part === keyId)
    if (key.split(':')[0] === keyIdStr && health.healthy) return true;
  }
  return !isHeartbeatEnabled();
}

/** Mark a key as unhealthy for a specific model.
 *  - Marks the specific key+model combo as unhealthy in the health map.
 *  - DB status: Only set api_keys.status = 'sick' if the key is unhealthy on
 *    ALL models for its platform. If any model for this key is still healthy,
 *    keep DB status as 'healthy'.
 *  - Schedules a recheck for the specific model.
 */
export function markKeyUnhealthy(keyId: number, modelId: string, error?: string, transient = false, recheckDelayMs?: number): void {
  if (!isHeartbeatEnabled()) return;
  // Transient 429s (per-minute/quota-window) should NOT evict the key from
  // the healthy pool or increment its penalty — they are expected and
  // self-resolving. We still schedule a recheck so the key gets verified
  // after the transient cooldown expires.
  if (transient) {
    scheduleRecheck(keyId, modelId, recheckDelayMs);
    return;
  }
  const key = healthKey(keyId, modelId);
  const prev = keyHealthMap.get(key);
  keyHealthMap.set(key, {
    penalty: (prev?.penalty ?? 0) + 1,
    lastPingAt: Date.now(),
    healthy: false,
    lastError: error ?? 'evicted by traffic 429',
  });

  // DB status: only mark 'sick' if key is unhealthy on ALL models for its platform
  const db = getDb();
  if (!isKeyHealthyOnAnyModel(keyId)) {
    db.prepare("UPDATE api_keys SET status = 'sick' WHERE id = ? AND status = 'healthy'").run(keyId);
  }
  scheduleRecheck(keyId, modelId, recheckDelayMs);
}

/**
 * Check whether the heartbeat feature is enabled and active.
 * Returns false when heartbeat is disabled, meaning all keys are usable
 * without prewarming (backward-compatible mode for router.ts).
 */
export function isHeartbeatEnabled(): boolean {
  return readConfig().enabled;
}

/** Get all key health states (for dashboard/debugging). Key is composite `${keyId}:${modelId}`. */
export function getAllKeyHealth(): Map<string, KeyHealth> {
  return new Map(keyHealthMap);
}

/** Schedule a proactive re-ping of an exhausted key+model after a configured delay.
 *  No-op if a recheck timer is already pending or in-flight for this key+model.
 *  If a prior cycle's in-flight check is stale (key marked unhealthy again),
 *  the new schedule supersedes it — the stale fireRecheck will detect this
 *  via the generation counter and exit without scheduling a next attempt. */
function scheduleRecheck(keyId: number, modelId: string, customDelayMs?: number): void {
  const key = healthKey(keyId, modelId);
  // FR-3: No duplicate timers — also blocks while a fireRecheck is in-flight
  const existing = recheckTimers.get(key);
  if (existing) {
    if (existing.inFlight) {
      // A fireRecheck is running for this key+model. Bump the generation so the
      // in-flight fireRecheck knows its cycle is stale and won't schedule
      // a next attempt. We start a fresh cycle from attempt 1.
      existing.generation = ++recheckGeneration;
      existing.attempt = 1;
      // Clear the old timer (already fired if in-flight, but be safe)
      if (existing.timerRef) clearTimeout(existing.timerRef);
      const { recheckSec } = readConfig();
      const delayMs = customDelayMs ?? recheckSec * 1000;
      existing.timerRef = setTimeout(() => {
        fireRecheck(keyId, modelId, 1).catch(err => {
          console.error(`[Heartbeat] Recheck error for key#${keyId} model ${modelId}:`, err);
        });
      }, delayMs);
      existing.inFlight = false;
      return;
    }
    if (customDelayMs !== undefined) {
      existing.generation = ++recheckGeneration;
      existing.attempt = 1;
      if (existing.timerRef) clearTimeout(existing.timerRef);
      existing.timerRef = setTimeout(() => {
        fireRecheck(keyId, modelId, 1).catch(err => {
          console.error(`[Heartbeat] Recheck error for key#${keyId} model ${modelId}:`, err);
        });
      }, customDelayMs);
      return;
    }
    return; // Already has a pending timer (not in-flight) — skip
  }

  const { recheckSec } = readConfig();
  const delayMs = customDelayMs ?? recheckSec * 1000;
  const generation = ++recheckGeneration;

  const timerRef = setTimeout(() => {
    fireRecheck(keyId, modelId, 1).catch(err => {
      console.error(`[Heartbeat] Recheck error for key#${keyId} model ${modelId}:`, err);
    });
  }, delayMs);

  recheckTimers.set(key, { keyId, modelId, attempt: 1, generation, timerRef, inFlight: false });
}

/** Fire a recheck ping for an exhausted key+model. Called when a recheck timer fires.
 *  Checks preconditions (key still unhealthy, not recently pinged, still enabled)
 *  before calling the existing pingKey() logic.
 *
 *  Race-safety: We mark the entry in-flight before the async ping and check
 *  the generation counter after the await. If scheduleRecheck() was called
 *  during the async gap (because the key was marked unhealthy again), the
 *  generation will have changed — we exit without scheduling a next attempt
 *  to avoid creating a duplicate recheck loop. */
async function fireRecheck(keyId: number, modelId: string, attempt: number): Promise<void> {
  const key = healthKey(keyId, modelId);
  const entry = recheckTimers.get(key);
  if (!entry) return; // Slot was cleared (stopHeartbeat / resetConfig)

  // Mark in-flight so scheduleRecheck sees the entry (FR-3 dedup)
  const myGeneration = entry.generation;
  entry.inFlight = true;
  entry.timerRef = null; // Timer already fired

  const health = keyHealthMap.get(key);
  // Key already recovered — clean up and done
  if (!health || health.healthy) {
    recheckTimers.delete(key);
    return;
  }

  const { recheckSec, maxRechecks, pingTimeoutMs } = readConfig();
  const minRecencyMs = recheckSec * 1000 / 2;

  // FR-4: Skip if this key+model was pinged very recently
  if (Date.now() - health.lastPingAt < minRecencyMs) {
    // Only schedule next if we still own the slot
    const currentEntry = recheckTimers.get(key);
    if (currentEntry && currentEntry.generation === myGeneration) {
      recheckTimers.delete(key);
      if (attempt < maxRechecks) {
        scheduleNextRecheck(keyId, modelId, attempt + 1);
      }
    }
    return;
  }

  // FR-5: Check key is still enabled in DB
  const db = getDb();
  const keyRow = db.prepare(
    "SELECT * FROM api_keys WHERE id = ? AND enabled = 1"
  ).get(keyId) as any | undefined;
  if (!keyRow) {
    recheckTimers.delete(key);
    return;
  }

  // Use the specific modelId for recheck (not highest-priority fallback)
  const model = db.prepare(`
    SELECT m.id AS model_db_id, m.model_id
    FROM models m
    WHERE m.model_id = ? AND m.enabled = 1 AND m.platform = ?
  `).get(modelId, keyRow.platform) as { model_db_id: number; model_id: string } | undefined;
  if (!model) {
    recheckTimers.delete(key);
    return;
  }

  const start = Date.now();
  await pingKey(keyRow.platform, model.model_db_id, model.model_id, keyRow, pingTimeoutMs);
  const latencyMs = Date.now() - start;

  // Post-await: check if our generation is still current
  // If scheduleRecheck() was called during the async gap (key got 429'd
  // again), it bumped the generation and started a fresh timer. We must
  // NOT schedule a next attempt — that would leak a duplicate timer.
  const currentEntry = recheckTimers.get(key);
  if (!currentEntry || currentEntry.generation !== myGeneration) {
    // Our cycle is stale — a newer recheck cycle owns the slot. Exit.
    return;
  }
  if (currentEntry.inFlight) {
    // Still marked in-flight (by us) — clean up
    recheckTimers.delete(key);
  }

  const newHealth = keyHealthMap.get(key);
  const success = !!newHealth?.healthy;

  if (success) {
    publish({
      type: 'heartbeat.recheck',
      keyId,
      provider: keyRow.platform,
      model: model.model_id,
      success: true,
      latencyMs,
      attempt,
      at: Date.now(),
    });
  } else {
    publish({
      type: 'heartbeat.recheck',
      keyId,
      provider: keyRow.platform,
      model: model.model_id,
      success: false,
      latencyMs,
      error: newHealth?.lastError?.slice(0, 120) ?? 'unknown',
      attempt,
      at: Date.now(),
    });

    if (attempt < maxRechecks) {
      scheduleNextRecheck(keyId, modelId, attempt + 1);
    }
  }
}

/** Schedule the next recheck attempt for a key+model that hasn't recovered yet. */
function scheduleNextRecheck(keyId: number, modelId: string, nextAttempt: number): void {
  const key = healthKey(keyId, modelId);
  const { recheckSec } = readConfig();
  const generation = ++recheckGeneration;

  const timerRef = setTimeout(() => {
    fireRecheck(keyId, modelId, nextAttempt).catch(err => {
      console.error(`[Heartbeat] Recheck error for key#${keyId} model ${modelId} (attempt ${nextAttempt}):`, err);
    });
  }, recheckSec * 1000);

  recheckTimers.set(key, { keyId, modelId, attempt: nextAttempt, generation, timerRef, inFlight: false });
}

/** Get pending recheck timers (read-only, for testing). */
export function getPendingRechecks(): ReadonlyMap<string, { keyId: number; modelId: string; attempt: number }> {
  return new Map([...recheckTimers].map(([k, v]) => [k, { keyId: v.keyId, modelId: v.modelId, attempt: v.attempt }]));
}

// ──────────────────────────────────────────────────────────────────────
// Configuration (lazy-initialized from feature-settings on first use)
// ──────────────────────────────────────────────────────────────────────

let _enabled: boolean | null = null;
let _intervalMs: number | null = null;
let _activityWindowMs: number | null = null;
let _pingTimeoutMs: number | null = null;
let _staggerMs: number | null = null;
let _concurrency: number | null = null;
let _recheckSec: number | null = null;
let _maxRechecks: number | null = null;

function readConfig() {
  if (_enabled === null) {
    _enabled = getFeatureSetting('heartbeat_enabled') as boolean;
    _intervalMs = (getFeatureSetting('heartbeat_interval_min') as number) * 60 * 1000;
    _activityWindowMs = (getFeatureSetting('heartbeat_activity_window_min') as number) * 60 * 1000;
    _pingTimeoutMs = getFeatureSetting('heartbeat_timeout_ms') as number;
    _staggerMs = getFeatureSetting('heartbeat_stagger_ms') as number;
    _concurrency = getFeatureSetting('heartbeat_concurrency') as number;
    _recheckSec = getFeatureSetting('heartbeat_exhausted_recheck_sec') as number;
    _maxRechecks = getFeatureSetting('heartbeat_exhausted_max_rechecks') as number;
  }
  return { enabled: _enabled, intervalMs: _intervalMs!, activityWindowMs: _activityWindowMs!, pingTimeoutMs: _pingTimeoutMs!, staggerMs: _staggerMs!, concurrency: _concurrency!, recheckSec: _recheckSec!, maxRechecks: _maxRechecks! };
}

/** Reset the cached config (used in tests and after settings change). */
export function resetHeartbeatConfig(): void {
  _enabled = null;
  _intervalMs = null;
  _activityWindowMs = null;
  _pingTimeoutMs = null;
  _staggerMs = null;
  _concurrency = null;
  _recheckSec = null;
  _maxRechecks = null;
  keyHealthMap.clear();

  // Clear pending rechecks
  for (const [, state] of recheckTimers) {
    if (state.timerRef) clearTimeout(state.timerRef);
  }
  recheckTimers.clear();
}

// ──────────────────────────────────────────────────────────────────────
// Module-level state
// ──────────────────────────────────────────────────────────────────────

let timerRef: ReturnType<typeof setInterval> | null = null;
let lastActivityAt = 0;
let cycleInProgress = false;

// ──────────────────────────────────────────────────────────────────────
// Recheck state (exhausted-key proactive recovery)
// ──────────────────────────────────────────────────────────────────────

interface RecheckState {
  keyId: number;
  modelId: string;
  attempt: number;       // 1-based
  /** Monotonically increasing generation counter. Incremented on each new
   *  scheduleRecheck() call so that in-flight fireRecheck() can detect
   *  whether its slot has been superseded by a newer recheck cycle. */
  generation: number;
  timerRef: ReturnType<typeof setTimeout> | null;
  /** True while fireRecheck is awaiting pingKey(). Prevents the async gap
   *  from allowing scheduleRecheck() to create a duplicate timer. */
  inFlight: boolean;
}

const recheckTimers = new Map<string, RecheckState>();
let recheckGeneration = 0;

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

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
    console.log(`[Heartbeat] Starting per-key-per-model timer (interval=${intervalMs / 1000}s)`);
    timerRef = setInterval(() => { runCycle().catch(e => console.error('[Heartbeat] Cycle error:', e)); }, intervalMs);
    timerRef.unref();

    // Startup prewarm: immediately fire a cycle to warm up all keys
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

  // Clear all pending recheck timers
  for (const [, state] of recheckTimers) {
    if (state.timerRef) clearTimeout(state.timerRef);
  }
  recheckTimers.clear();
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
 *  If modelId is provided, ping that specific model. Otherwise, find the
 *  highest-priority model for the key's platform (current behavior).
 *
 *  Does NOT block on cycleInProgress — a single-key ping runs independently
 *  of the cycle state. When heartbeat is disabled, returns true immediately
 *  (backward compat: all keys assumed healthy). */
export async function pokeKey(keyId: number, modelId?: string): Promise<boolean> {
  if (!isHeartbeatEnabled()) return true;

  const db = getDb();
  const keyRow = db.prepare(
    "SELECT * FROM api_keys WHERE id = ? AND enabled = 1"
  ).get(keyId) as any | undefined;
  if (!keyRow) return false;

  let model: { model_db_id: number; model_id: string } | undefined;
  if (modelId) {
    // Use the specified model
    const row = db.prepare(`
      SELECT m.id AS model_db_id, m.model_id
      FROM models m
      WHERE m.model_id = ? AND m.enabled = 1 AND m.platform = ?
    `).get(modelId, keyRow.platform) as { model_db_id: number; model_id: string } | undefined;
    model = row;
  } else {
    // Get the highest-priority model for this key's platform
    model = db.prepare(`
      SELECT m.id AS model_db_id, m.model_id
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
      WHERE fc.enabled = 1 AND m.platform = ?
      ORDER BY fc.priority ASC
      LIMIT 1
    `).get(keyRow.platform) as { model_db_id: number; model_id: string } | undefined;
  }
  if (!model) return false;

  const { pingTimeoutMs } = readConfig();
  await pingKey(keyRow.platform, model.model_db_id, model.model_id, keyRow, pingTimeoutMs);
  return isKeyHealthy(keyId, model.model_id);
}

// ──────────────────────────────────────────────────────────────────────
// Internal: cycle logic
// ──────────────────────────────────────────────────────────────────────

async function runCycle(skipGate = false): Promise<number> {
  if (cycleInProgress) return 0;
  cycleInProgress = true;

  try {
    const now = Date.now();
    const { activityWindowMs, pingTimeoutMs, concurrency, staggerMs } = readConfig();

    // Activity gate — bypassed for startup prewarm (skipGate=true)
        if (!skipGate && (lastActivityAt === 0 || now - lastActivityAt > activityWindowMs)) {
          publish({
            type: 'heartbeat.cycle_skipped',
            reason: 'activity_gate',
            lastActivityAgeMs: lastActivityAt === 0 ? -1 : now - lastActivityAt,
            at: now,
          });
          return 0;
        }

        // ─── Prune stale keyHealthMap entries for models that no longer exist ───
        // Get all currently enabled models from the fallback chain
        const db = getDb();
        const activeModels = db.prepare(`
          SELECT m.platform, m.id AS model_db_id, m.model_id
          FROM fallback_config fc
          JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
          WHERE fc.enabled = 1
        `).all() as Array<{ platform: string; model_db_id: number; model_id: string }>;

        // Build set of valid composite keys
        const validKeys = new Set<string>();
        const keysForPlatform = new Map<string, number[]>();
        for (const m of activeModels) {
          const platformKeys = db.prepare(
            "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1"
          ).all(m.platform) as Array<{ id: number }>;
          for (const k of platformKeys) {
            validKeys.add(healthKey(k.id, m.model_id));
            // Track keys per platform for missing-model detection
            if (!keysForPlatform.has(m.platform)) keysForPlatform.set(m.platform, []);
            keysForPlatform.get(m.platform)!.push(k.id);
          }
        }

        // Prune: remove any health entry not in validKeys
        let pruned = 0;
        for (const existingKey of keyHealthMap.keys()) {
          if (!validKeys.has(existingKey)) {
            keyHealthMap.delete(existingKey);
            pruned++;
          }
        }
        if (pruned > 0) {
          console.log(`[Heartbeat] Pruned ${pruned} stale health entries for removed models/keys`);
        }

        // Get enabled models from the fallback chain
        // Order by priority so we deterministically use the highest-priority model
        // on each platform to ping all of its keys. Without ordering, a key might
        // randomly be pinged with a restricted model on some cycles (causing
        // 403/404 failures) and a standard model on others.
        const models = db.prepare(`
          SELECT m.platform, m.id AS model_db_id, m.model_id, MIN(fc.priority) AS priority
          FROM fallback_config fc
          JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
          WHERE fc.enabled = 1
          GROUP BY m.platform, m.id, m.model_id
          ORDER BY priority ASC
        `).all() as Array<{ platform: string; model_db_id: number; model_id: string }>;

    if (models.length === 0) return 0;

    // Collect all keys for each platform+model combo
    type PingTask = {
      platform: string;
      modelDbId: number;
      modelId: string;
      key: any;
    };
    const pingTasks: PingTask[] = [];

    // REMOVED seenKeys dedup — each key must be pinged for EVERY model
    // on its platform, because a key can be healthy on one model but sick on another.
    for (const model of models) {
      const keys = db.prepare(
        "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown', 'error', 'sick')"
      ).all(model.platform) as any[];

      for (const key of keys) {
        // NO dedup — ping for each model separately
        pingTasks.push({
          platform: model.platform,
          modelDbId: model.model_db_id,
          modelId: model.model_id,
          key,
        });
      }
    }

    const pingTaskGroupsByKey = new Map<number, PingTask[]>();
    for (const task of pingTasks) {
      const keyTasks = pingTaskGroupsByKey.get(task.key.id);
      if (keyTasks) {
        keyTasks.push(task);
      } else {
        pingTaskGroupsByKey.set(task.key.id, [task]);
      }
    }
    const pingTaskGroups = Array.from(pingTaskGroupsByKey.values());

    const runKeyGroup = async (group: PingTask[]): Promise<void> => {
      for (let i = 0; i < group.length; i++) {
        const task = group[i];
        await pingKey(task.platform, task.modelDbId, task.modelId, task.key, pingTimeoutMs)
          .catch(err => {
            console.error(`[Heartbeat] Ping error for key#${task.key.id} on ${task.platform}/${task.modelId}:`, err);
          });

        if (staggerMs > 0 && i + 1 < group.length) {
          await sleep(staggerMs);
        }
      }
    };

    // Ping key groups concurrently, but never run two pings for the same API key at once.
    for (let i = 0; i < pingTaskGroups.length; i += concurrency) {
      const batch = pingTaskGroups.slice(i, i + concurrency);
      await Promise.allSettled(batch.map(group => runKeyGroup(group)));
      if (concurrency === 1 && staggerMs > 0 && i + concurrency < pingTaskGroups.length) {
        await sleep(staggerMs);
      }
    }

    return pingTasks.length;
  } finally {
    cycleInProgress = false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Internal: ping a single key
// ──────────────────────────────────────────────────────────────────────

async function pingKey(platform: string, modelDbId: number, modelId: string, keyRow: any, pingTimeoutMs: number): Promise<void> {
  const provider = buildProviderFor(platform);
  if (!provider) return;

  let decryptedKey: string;
  try {
    decryptedKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch {
    // Decrypt failure is permanent — mark key unhealthy so the router
    // deprioritizes it until a successful ping or manual key check restores it.
    const key = healthKey(keyRow.id, modelId);
    keyHealthMap.set(key, {
      penalty: 0,
      lastPingAt: Date.now(),
      healthy: false,
      lastError: 'decrypt failed',
    });
    const db = getDb();
    db.prepare("UPDATE api_keys SET status = 'sick' WHERE id = ? AND status = 'healthy'").run(keyRow.id);
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

    // Success — mark key+model healthy and reduce model-level degradation
    const key = healthKey(keyRow.id, modelId);
    keyHealthMap.set(key, {
      penalty: 0,
      lastPingAt: Date.now(),
      healthy: true,
    });
    const db = getDb();
    // If this key was sick in DB, check if it's now healthy on the model
    // that was just tested. If so, set DB status back to 'healthy'
    // (one successful model = key is usable).
    const prevStatus = db.prepare("SELECT status FROM api_keys WHERE id = ?").get(keyRow.id) as { status: string } | undefined;
    if (prevStatus?.status === 'sick') {
      // Check if key is now healthy on ANY model
      if (isKeyHealthyOnAnyModel(keyRow.id)) {
        db.prepare("UPDATE api_keys SET status = 'healthy' WHERE id = ? AND status = 'sick'").run(keyRow.id);
      }
    }
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
      const key = healthKey(keyRow.id, modelId);
      const prev = keyHealthMap.get(key);
      const newPenalty = (prev?.penalty ?? 0) + 1;
      keyHealthMap.set(key, {
        penalty: newPenalty,
        lastPingAt: Date.now(),
        healthy: false,
        lastError: (err?.message ?? 'unknown').slice(0, 120),
      });
      const db = getDb();
      // DB: Only set sick if key is unhealthy on ALL models for its platform
      if (!isKeyHealthyOnAnyModel(keyRow.id)) {
        db.prepare("UPDATE api_keys SET status = 'sick' WHERE id = ? AND status = 'healthy'").run(keyRow.id);
      }
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

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

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
