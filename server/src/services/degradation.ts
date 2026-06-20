/**
 * Dynamic Degradation Engine
 *
 * Replaces the flat 429-penalty system with progressive, severity-weighted
 * degradation. Penalties compound multiplicatively for consecutive failures,
 * decay exponentially with severity-linked half-lives, and integrate into
 * the routing pipeline as a single multiplicative guardrail factor.
 *
 * Pure logic module — no database access, no HTTP concerns.
 */
import { publish } from './events.js';

// ── Configuration types ────────────────────────────────────────────────────────

interface DegradationTierConfig {
  weight: number;
  halfLifeMs: number;
}

interface DegradationConfig {
  minor: DegradationTierConfig;
  major: DegradationTierConfig;
  critical: DegradationTierConfig & { consecutiveThreshold: number };
  compoundFactor: number;
  successRecovery: number;
  dampStrength: number;
  maxPenalty: number;
}

// ── Per-model state ────────────────────────────────────────────────────────────

export interface DegradationState {
  /** Accumulated penalty (0 = healthy, MAX_PENALTY = dead). */
  penalty: number;

  /** Severity tier that drove the most recent half-life (for half-life ratchet). */
  tier: 'minor' | 'major' | 'critical';

  /** Consecutive failure count (all tiers) since last success. Reset on success. */
  consecutiveHits: number;

  /** Consecutive MAJOR failure count since last success or minor failure. Reset on success or minor hit. */
  consecutiveMajorHits: number;

  /** Timestamp (ms) of the most recent failure. Used for time-decay. Always a valid number. */
  lastHitAt: number;

  /** Half-life (ms) currently in effect. Ratchets up, resets to minor only at penalty=0. */
  halfLifeMs: number;

  /** Dirty flag — true if state changed since last DB flush. */
  dirty: boolean;
}

// ── Module state ───────────────────────────────────────────────────────────────

let config: DegradationConfig | null = null;
const degradationStates = new Map<number, DegradationState>();

// ── Config helpers ─────────────────────────────────────────────────────────────

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = parseFloat(raw);
  return isNaN(v) ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = parseInt(raw, 10);
  return isNaN(v) ? fallback : v;
}

function envMinutesToMs(name: string, fallbackMinutes: number): number {
  return envFloat(name, fallbackMinutes) * 60 * 1000;
}

function getConfig(): DegradationConfig {
  if (!config) {
    throw new Error('[Degradation] Engine not initialized — call initDegradation() first.');
  }
  return config;
}

// ── Initialization ─────────────────────────────────────────────────────────────

/**
 * Reads env vars, merges overrides, freezes config. Idempotent — calling
 * multiple times resets and re-reads.
 */
export function initDegradation(configOverrides?: Partial<DegradationConfig>): void {
  const minorHalfLifeMs = envMinutesToMs('DEGRADE_MINOR_HALF_LIFE_MIN', 2);
  const majorHalfLifeMs = envMinutesToMs('DEGRADE_MAJOR_HALF_LIFE_MIN', 15);
  const criticalHalfLifeMs = envMinutesToMs('DEGRADE_CRITICAL_HALF_LIFE_MIN', 60);

  const base: DegradationConfig = {
    minor: {
      weight: envFloat('DEGRADE_MINOR_WEIGHT', 1.0),
      halfLifeMs: minorHalfLifeMs,
    },
    major: {
      weight: envFloat('DEGRADE_MAJOR_WEIGHT', 3.0),
      halfLifeMs: majorHalfLifeMs,
    },
    critical: {
      weight: envFloat('DEGRADE_CRITICAL_WEIGHT', 6.0),
      halfLifeMs: criticalHalfLifeMs,
      consecutiveThreshold: envInt('DEGRADE_CRITICAL_THRESHOLD', 3),
    },
    compoundFactor: envFloat('DEGRADE_COMPOUND_FACTOR', 1.5),
    successRecovery: envFloat('DEGRADE_SUCCESS_RECOVERY', 0.3),
    dampStrength: envFloat('DEGRADE_DAMP_STRENGTH', 50),
    maxPenalty: envFloat('DEGRADE_MAX_PENALTY', 100),
  };

  if (configOverrides) {
    Object.assign(base, configOverrides);
    if (configOverrides.minor) Object.assign(base.minor, configOverrides.minor);
    if (configOverrides.major) Object.assign(base.major, configOverrides.major);
    if (configOverrides.critical) Object.assign(base.critical, configOverrides.critical);
  }

  config = Object.freeze({
    ...base,
    minor: Object.freeze(base.minor),
    major: Object.freeze(base.major),
    critical: Object.freeze(base.critical),
  });

  // Clear states on re-init (for tests)
  degradationStates.clear();
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Pure exponential decay with float snapping — no side effects.
 * penalty × 0.5^(elapsed / halfLife). Snaps to 0 when result < 0.01.
 */
export function applyDecay(penalty: number, elapsedMs: number, halfLifeMs: number): number {
  if (penalty <= 0 || elapsedMs <= 0) return penalty;
  const halfLives = elapsedMs / halfLifeMs;
  const result = penalty * Math.pow(0.5, halfLives);
  return result < 0.01 ? 0 : result;
}

function getOrCreateState(modelDbId: number): DegradationState {
  let state = degradationStates.get(modelDbId);
  if (!state) {
    const cfg = getConfig();
    state = {
      penalty: 0,
      tier: 'minor',
      consecutiveHits: 0,
      consecutiveMajorHits: 0,
      lastHitAt: Date.now(),
      halfLifeMs: cfg.minor.halfLifeMs,
      dirty: false,
    };
    degradationStates.set(modelDbId, state);
  }
  return state;
}

// ── Error classification ───────────────────────────────────────────────────────

/**
 * Classifies a provider error into a degradation tier.
 * Returns `null` if the error is non-retryable or non-degrading.
 *
 * Checks `err.status` numeric field FIRST, falls back to message matching.
 */
export function classifyError(err: any): 'minor' | 'major' | null {
  const msg = (err?.message ?? '').toLowerCase();

  // ── Primary: numeric status code (most reliable) ──────────────────────────
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (typeof status === 'number') {
    if (status === 429) {
      // Hard quota vs soft rate limit
      if (msg.includes('quota') || msg.includes('insufficient')) return null;
      return 'minor';
    }
    if (status === 402) return 'minor';
    if (status >= 500 && status < 600) return 'major';
    // 4xx client errors (including 404, 403) → non-degrading
    return null;
  }

  // ── Fallback: message-based classification ─────────────────────────────────

  // Client-side abort → non-degrading (check exact name; avoid matching 'econnaborted')
  if (err?.name === 'AbortError') return null;

  // Hard quota in message → non-degrading
  if (msg.includes('quota') || msg.includes('insufficient')) return null;

  // 429 / rate limit → minor (soft only; quota already excluded)
  if (msg.includes('429') || msg.includes('rate limit')) return 'minor';

  // 402 → minor
  if (msg.includes('402') || msg.includes('payment required')) return 'minor';

  // 5xx → major
  if (
    msg.includes('500') || msg.includes('502') || msg.includes('503') ||
    msg.includes('504') || msg.includes('server error') ||
    msg.includes('service unavailable')
  ) return 'major';

  // Network / timeout / TLS → major (check BEFORE generic 'abort' to catch ECONNABORTED)
  if (
    msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('econnreset') ||
    msg.includes('etimedout') || msg.includes('enotfound') || msg.includes('eproto') ||
    msg.includes('econnabort') || msg.includes('fetch failed')
  ) return 'major';

  // Generic abort → non-degrading (after network errors so ECONNABORTED isn't caught here)
  if (msg.includes('abort')) return null;

  // Unknown → non-degrading
  return null;
}

// ── Failure recording ──────────────────────────────────────────────────────────

/**
 * Called from proxy.ts after any retryable failure. Mutates in-memory state.
 * Uses lazy-read decay model: mutations apply time-decay to the stored penalty,
 * then apply their change — re-anchoring the stored penalty to the current time.
 */
export function recordFailure(modelDbId: number, tier: 'minor' | 'major'): void {
  const state = getOrCreateState(modelDbId);
  const cfg = getConfig();
  const now = Date.now();

  // 1. Apply time-decay to STORED penalty (re-anchor to now)
  const elapsed = now - state.lastHitAt;
  state.penalty = applyDecay(state.penalty, elapsed, state.halfLifeMs);
  state.penalty = Math.max(0, state.penalty);

  // 2. Increment consecutive counters
  state.consecutiveHits++;
  if (tier === 'major') {
    state.consecutiveMajorHits++;
  } else {
    // Minor failure breaks the "consecutive major" streak
    state.consecutiveMajorHits = 0;
  }

  // 3. Determine effective tier for this hit
  let effectiveTier: 'minor' | 'major' | 'critical' = tier;
  if (tier === 'major' && state.consecutiveMajorHits >= cfg.critical.consecutiveThreshold) {
    effectiveTier = 'critical';
  }

  // 4. Compute severity weight for this hit
  const weight = cfg[effectiveTier].weight;

  // 5. Compound: exponent = max(0, consecutiveHits - 1)
  const exponent = Math.max(0, state.consecutiveHits - 1);
  const compound = Math.pow(cfg.compoundFactor, exponent);
  const increment = weight * compound;

  // 6. Accumulate, clamped
  state.penalty = Math.min(cfg.maxPenalty, state.penalty + increment);

  // 7. Ratchet half-life up (never down)
  const newHalfLife = cfg[effectiveTier].halfLifeMs;
  if (newHalfLife > state.halfLifeMs) {
    state.halfLifeMs = newHalfLife;
  }
  state.tier = effectiveTier;
  state.lastHitAt = now;
  state.dirty = true;

  // 8. Emit event
  publish({
    type: 'degradation.hit',
    modelDbId,
    tier: effectiveTier,
    penalty: state.penalty,
    consecutive: state.consecutiveHits,
    consecutiveMajor: state.consecutiveMajorHits,
    at: now,
  } as any);
}

// ── Success recording ──────────────────────────────────────────────────────────

/**
 * Called from proxy.ts on every successful response.
 * Reduces the penalty using floor() deterministic recovery.
 */
export function recordSuccess(modelDbId: number): void {
  const state = degradationStates.get(modelDbId);
  if (!state || state.penalty <= 0) return;

  const cfg = getConfig();
  const now = Date.now();

  // 1. Apply time-decay to STORED penalty (re-anchor to now)
  const elapsed = now - state.lastHitAt;
  state.penalty = applyDecay(state.penalty, elapsed, state.halfLifeMs);
  state.penalty = Math.max(0, state.penalty);

  // 2. Recovery: floor() for deterministic integer steps
  const recovery = Math.min(state.penalty, Math.max(1, Math.floor(state.penalty * cfg.successRecovery)));
  state.penalty = Math.max(0, state.penalty - recovery);

  // 3. Reset both consecutive counters
  state.consecutiveHits = 0;
  state.consecutiveMajorHits = 0;

  // 4. If penalty is low enough, snap to zero and reset half-life
  if (state.penalty < 1) {
    state.penalty = 0;
    state.tier = 'minor';
    state.halfLifeMs = cfg.minor.halfLifeMs;
  }

  // 5. Clean up zero-penalty entries from memory
  if (state.penalty <= 0) {
    degradationStates.delete(modelDbId);
  } else {
    state.dirty = true;
  }

  // 6. Emit event
  publish({
    type: 'degradation.recovery',
    modelDbId,
    penalty: state.penalty,
    at: now,
  } as any);
}

// ── Read-only queries ──────────────────────────────────────────────────────────

/**
 * Lazy time-decayed penalty (read-only, never mutates stored state).
 */
export function getPenalty(modelDbId: number): number {
  const state = degradationStates.get(modelDbId);
  if (!state) return 0;
  const elapsed = Date.now() - state.lastHitAt;
  return applyDecay(state.penalty, elapsed, state.halfLifeMs);
}

/**
 * The guardrail multiplier for combineScore.
 * 1 / (1 + normalized² × dampStrength)
 */
export function getDegradationFactor(modelDbId: number): number {
  const penalty = getPenalty(modelDbId);
  if (penalty <= 0) return 1;
  const cfg = getConfig();
  const normalized = penalty / cfg.maxPenalty;
  return 1 / (1 + normalized * normalized * cfg.dampStrength);
}

/**
 * Maps current penalty to a display-friendly tier (FR-6 Tier Display Policy).
 */
export function getDisplayTier(penalty: number): 'healthy' | 'minor' | 'major' | 'critical' {
  if (penalty <= 0) return 'healthy';
  if (penalty <= 10) return 'minor';
  if (penalty <= 30) return 'major';
  return 'critical';
}

/**
 * Returns raw internal states (for persistence). No decay applied. Returns a COPY.
 */
export function getAllStatesRaw(): Map<number, DegradationState> {
  return new Map(degradationStates);
}

/**
 * Returns decayed view of states (for dashboard/API). Penalty is time-decayed. Returns a COPY.
 */
export function getAllStatesView(): Map<number, DegradationState & { displayTier: string }> {
  const result = new Map<number, DegradationState & { displayTier: string }>();
  for (const [id, state] of degradationStates) {
    const elapsed = Date.now() - state.lastHitAt;
    const penalty = applyDecay(state.penalty, elapsed, state.halfLifeMs);
    result.set(id, {
      ...state,
      penalty,
      displayTier: getDisplayTier(penalty),
    });
  }
  return result;
}

// ── State hydration ────────────────────────────────────────────────────────────

/**
 * Hydrate a saved state into the in-memory map (startup from DB).
 */
export function loadState(modelDbId: number, state: DegradationState): void {
  degradationStates.set(modelDbId, { ...state });
}

// ── Persistence helpers ────────────────────────────────────────────────────────

/**
 * Returns states where dirty === true. Marks them as clean (dirty=false).
 */
export function flushDirtyStates(): Array<{ modelDbId: number; state: DegradationState }> {
  const dirty: Array<{ modelDbId: number; state: DegradationState }> = [];
  for (const [modelDbId, state] of degradationStates) {
    if (state.dirty) {
      dirty.push({ modelDbId, state: { ...state } });
      state.dirty = false;
    }
  }
  return dirty;
}

/**
 * Evicts entries with lazy-decayed penalty < 0.01. Returns evicted modelDbIds.
 */
export function evictGhostStates(): number[] {
  const evicted: number[] = [];
  for (const [modelDbId, state] of degradationStates) {
    const elapsed = Date.now() - state.lastHitAt;
    const decayed = applyDecay(state.penalty, elapsed, state.halfLifeMs);
    if (decayed < 0.01) {
      degradationStates.delete(modelDbId);
      evicted.push(modelDbId);
    }
  }
  return evicted;
}
