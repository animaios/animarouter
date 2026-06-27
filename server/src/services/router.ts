import type { Database } from "better-sqlite3";
import crypto from "crypto";
import { getDb, getSetting, setSetting } from "../db/index.js";
import { decrypt } from "../lib/crypto.js";
import type { BaseProvider } from "../providers/base.js";
import { buildProviderFor } from "../providers/index.js";
import {
  getAllStatesView,
  getBoost,
  getDegradationFactor,
  getPenalty,
  initDegradation,
} from "./degradation.js";
import { publish } from "./events.js";
import { getFeatureSetting } from "./feature-settings.js";
// Rate-limit pre-checks removed — routing relies on heartbeat-based health
// detection instead of predictive quota tracking. See PR: heartbeat per-key.
// recordRequest/recordTokens still track usage for analytics purposes.
import { getKeyHealth, isHeartbeatEnabled, isKeyHealthy } from "./heartbeat.js";
import { isExhausted } from "./key-exhaustion.js";
import {
  type TransportId,
  transportIdFromUseProxy,
} from "./proxy-transport.js";
import {
  BANDIT_PRESETS,
  combineScore,
  DEFAULT_STRATEGY,
  expectedReliability,
  heavyWeightedLatencyScore,
  heavyWeightedSpeedScore,
  intelligenceScore,
  latencyCompositeFromSize,
  type RoutingStrategy,
  type RoutingWeights,
  reliabilityPosterior,
  sampleBeta,
  speedCompositeFromRank,
  speedScore,
} from "./scoring.js";

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
  use_proxy: number;
}

// Chain row joined with the model fields the bandit needs to score it.
interface ChainRow {
  model_db_id: number;
  priority: number;
  enabled: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  speed_rank: number;
  size_label: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  supports_vision: number;
  supports_tools: number;
  context_window: number | null;
  /** Hard upper bound on output tokens the provider/upstream enforces. Used
   * as the default `max_tokens` when the caller doesn't supply one — some
   * upstreams (NVIDIA NIM minimax-m3) refuse to generate without an explicit
   * limit and return an empty 200 instead of an error, which the proxy can't
   * diagnose. NULL means "no upper-bound known" and the proxy leaves whatever
   * the caller sent (or omits the field entirely). */
  max_output_tokens: number | null;
  // Custom models bind to the api_keys row carrying their endpoint (#212);
  // NULL for built-in platforms.
  key_id: number | null;
  /** Benchmark-derived intelligence score [0, 100] from Artificial Analysis
   * Intelligence Index. NULL = no published score. When available, this is a
   * much better cross-provider intelligence signal than size_label + rank. */
  benchmark_score: number | null;
}

// Group-aware routing: a chain entry is a model group, not a single model.
interface GroupChainRow {
  group_id: number;
  priority: number;
  enabled: number;
  group_key: string;
  display_name: string;
  benchmark_score: number | null;
  intelligence_rank: number | null;
  size_label: string;
  context_window: number | null;
  max_output_tokens: number | null;
  supports_vision: number;
  supports_tools: number;
}

// A provider (model row) within a group.
interface ProviderRow {
  model_db_id: number;
  group_id: number;
  platform: string;
  model_id: string;
  display_name: string;
  speed_rank: number;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  key_id: number | null;
  enabled: number;
  supports_vision: number;
  supports_tools: number;
  context_window: number | null;
  benchmark_score: number | null;
  intelligence_rank: number | null;
  size_label: string;
  max_output_tokens: number | null;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
  /** Whether this route should use the FreeLLMProxy transport instead of direct provider connection. */
  useProxy: boolean;
  /** Selected outbound transport. `useProxy` is kept as API/backward-compatible sugar. */
  transportId: TransportId;
  // Daily limits for this model, so a 429 handler can tell a genuine daily
  // exhaustion (escalate the cooldown) from a transient per-minute spike.
  rpdLimit: number | null;
  tpdLimit: number | null;
  /** Catalog's hard upper bound on the model's output tokens. Used by the
   * proxy as a fallback `max_tokens` when the caller doesn't supply one
   * (NVIDIA NIM minimax-m3 returns empty 200s without an explicit limit). */
  maxOutputTokens: number | null;
  /** When group-aware routing is active, the model_groups.id this route came from. */
  groupId?: number;
  // Decrements the in-flight slot for the associated provider.
  // Callers MUST invoke this in a finally block after the request completes.
  release: () => void;
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

/** Rotate an array by `offset` positions, wrapping around. */
function rotateArray<T>(arr: T[], offset: number): T[] {
  if (arr.length === 0) return arr;
  const shift = offset % arr.length;
  return [...arr.slice(shift), ...arr.slice(0, shift)];
}

// ──────────────────────────────────────────────────────────────────────────────
// Ping-weighted key shuffle
// When heartbeat is enabled, healthy keys are shuffled with probability
// proportional to inverse latency so faster keys are picked more often,
// while still giving slower keys a chance (Boltzmann exploration).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Shuffle keys by perceived ping latency with weighted randomness.
 * Keys with lower latency get higher probability of appearing first.
 * Uses exponential noise / weight ordering (equivalent to sampling without
 * replacement from a categorical distribution with weights ∝ 1/(latency+baseline)).
 */
function pingWeightedShuffle(keys: KeyRow[], modelId: string): KeyRow[] {
  if (keys.length <= 1) return keys;

  // Baseline latency (ms) added to weight denominator so unknown/slow keys
  // still get nonzero weight. Tuned to ~100ms — roughly network RTT floor.
  const BASELINE_LATENCY_MS = 100;

  const scored = keys.map((key) => {
    const health = getKeyHealth(key.id, modelId);
    const latency = health?.lastPingLatencyMs ?? 2000; // unknown keys get 2s default
    const weight = 1 / (latency + BASELINE_LATENCY_MS);
    // Exponential noise: -ln(U) / weight. Higher weight → smaller score → picked earlier.
    const noise = -Math.log(1 - Math.random() + 1e-15);
    const score = noise / weight;
    return { key, score };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.key);
}

// ── Parallel request gating ──
// Per-provider (platform slug) in-flight counter. The limit is provider-level
// so that the total concurrency across all models of one custom provider never
// exceeds maxParallelRequests. Built-in providers are implicitly unlimited.
const providerInFlight = new Map<
  string,
  { count: number; limit: number | null }
>();

/** Try to reserve one in-flight slot for the given platform slug.
 *  Returns true if the slot was reserved, false if the provider is at capacity. */
function tryReserveSlot(platform: string, maxParallel: number | null): boolean {
  if (maxParallel === null || maxParallel === undefined || maxParallel <= 0)
    return true;
  let entry = providerInFlight.get(platform);
  if (!entry) {
    entry = { count: 0, limit: maxParallel };
    providerInFlight.set(platform, entry);
  }
  if (entry.count >= maxParallel) return false;
  entry.count++;
  return true;
}

/** Release one in-flight slot for the given platform slug. */
function releaseSlot(platform: string): void {
  const entry = providerInFlight.get(platform);
  if (entry && entry.count > 0) entry.count--;
}

// ── Degradation integration ──────────────────────────────────────────────────
// The degradation engine (degradation.ts) replaces the old flat 429-penalty
// system with progressive, severity-weighted degradation. State is in-memory;
// persistence is handled by periodic flushes (see index.ts).

let degradationInitialized = false;
function ensureDegradationInit() {
  if (!degradationInitialized) {
    initDegradation();
    degradationInitialized = true;
  }
}

/**
 * Get current penalties for all models (for the API/dashboard).
 * Backward-compatible wrapper around getAllStatesView().
 */
export function getAllPenalties(): Array<{
  modelDbId: number;
  count: number;
  penalty: number;
}> {
  const states = getAllStatesView();
  const result: Array<{ modelDbId: number; count: number; penalty: number }> =
    [];
  for (const [modelDbId, state] of states) {
    if (state.penalty > 0) {
      result.push({
        modelDbId,
        count: state.consecutiveHits,
        penalty: state.penalty,
      });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

// ── Routing strategy (persisted) ────────────────────────────────────────────
const STRATEGY_KEY = "routing_strategy";
const CUSTOM_WEIGHTS_KEY = "routing_custom_weights";
const VALID_STRATEGIES: RoutingStrategy[] = [
  "priority",
  "balanced",
  "smartest",
  "fastest",
  "reliable",
  "custom",
];

export function getRoutingStrategy(): RoutingStrategy {
  ensureDegradationInit();
  const raw = getSetting(STRATEGY_KEY);
  return raw && VALID_STRATEGIES.includes(raw as RoutingStrategy)
    ? (raw as RoutingStrategy)
    : DEFAULT_STRATEGY;
}

export function setRoutingStrategy(strategy: RoutingStrategy): void {
  if (!VALID_STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown routing strategy: ${strategy}`);
  }
  setSetting(STRATEGY_KEY, strategy);
}

// ── Custom weights (persisted) ──────────────────────────────────────────────
// User-tuned weight vector for the 'custom' strategy. Stored normalized (sums
// to 1) so the dashboard percentages read cleanly; combineScore would tolerate
// any non-negative vector regardless. Falls back to the balanced preset until
// the user has saved their own.
export function getCustomWeights(): RoutingWeights {
  const raw = getSetting(CUSTOM_WEIGHTS_KEY);
  if (raw) {
    try {
      const w = JSON.parse(raw) as Partial<RoutingWeights>;
      const reliability = w.reliability ?? 0;
      const speed = w.speed ?? 0;
      const intelligence = w.intelligence ?? 0;
      const latency = w.latency ?? 0.2; // default for old 3-axis stored weights
      if (
        [reliability, speed, intelligence, latency].every(
          (v) => Number.isFinite(v) && v >= 0,
        ) &&
        reliability + speed + intelligence + latency > 0
      ) {
        return { reliability, speed, intelligence, latency };
      }
    } catch {
      /* corrupt setting → fall through to default */
    }
  }
  return { ...BANDIT_PRESETS.balanced };
}

export function setCustomWeights(weights: RoutingWeights): void {
  const { reliability, speed, intelligence, latency } = weights;
  if (
    ![reliability, speed, intelligence, latency].every(
      (v) => Number.isFinite(v) && v >= 0,
    )
  ) {
    throw new Error("Custom weights must be non-negative numbers");
  }
  const sum = reliability + speed + intelligence + latency;
  if (sum <= 0) {
    throw new Error("Custom weights must not all be zero");
  }
  setSetting(
    CUSTOM_WEIGHTS_KEY,
    JSON.stringify({
      reliability: reliability / sum,
      speed: speed / sum,
      intelligence: intelligence / sum,
      latency: latency / sum,
    }),
  );
}

function weightsFor(strategy: RoutingStrategy): RoutingWeights | null {
  if (strategy === "priority") return null;
  if (strategy === "custom") return getCustomWeights();
  return BANDIT_PRESETS[strategy];
}

// ── Analytics stats cache (decay-weighted) ──────────────────────────────────
// Constants now backed by feature settings (scoring_window_days, scoring_decay_half_life_days, scoring_cache_ttl_sec).
function getScoringWindowMs(): number {
  return (
    (getFeatureSetting("scoring_window_days") as number) * 24 * 60 * 60 * 1000
  );
}

function getScoringHalfLifeDays(): number {
  return getFeatureSetting("scoring_decay_half_life_days") as number;
}

function getScoringCacheTtlMs(): number {
  return (getFeatureSetting("scoring_cache_ttl_sec") as number) * 1000;
}

interface ModelStats {
  successes: number; // decay-weighted pseudo-count
  failures: number; // decay-weighted pseudo-count
  tokPerSec: number; // from successful requests only (0 = no data)
  avgTtfbMs: number | null; // null = no first-byte timing yet
}

let statsCache: Map<string, ModelStats> | null = null;
let statsCacheTime = 0;

function decayWeight(ageDays: number): number {
  return 0.5 ** (Math.max(0, ageDays) / getScoringHalfLifeDays());
}

export function refreshStatsCache(db: Database, force = false): void {
  if (
    !force &&
    statsCache &&
    Date.now() - statsCacheTime < getScoringCacheTtlMs()
  )
    return;

  // Clear the temporary table
  db.prepare("DELETE FROM model_stats_temp").run();

  const since = new Date(Date.now() - getScoringWindowMs()).toISOString();
  const buckets = db
    .prepare(`
    SELECT platform, model_id,
      CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS age_days,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'success' THEN output_tokens + reasoning_tokens ELSE 0 END) AS succ_out,
      SUM(CASE WHEN status = 'success' THEN latency_ms ELSE 0 END) AS succ_lat,
      SUM(CASE WHEN status = 'success' AND ttfb_ms IS NOT NULL THEN ttfb_ms ELSE 0 END) AS succ_ttfb_sum,
      SUM(CASE WHEN status = 'success' AND ttfb_ms IS NOT NULL THEN 1 ELSE 0 END) AS succ_ttfb_cnt
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform, model_id, age_days
  `)
    .all(since) as Array<{
    platform: string;
    model_id: string;
    age_days: number;
    total: number;
    successes: number;
    succ_out: number;
    succ_lat: number;
    succ_ttfb_sum: number;
    succ_ttfb_cnt: number;
  }>;

  // Accumulate decay-weighted sums per model.
  const acc = new Map<
    string,
    {
      wSucc: number;
      wFail: number;
      wOut: number;
      wLat: number;
      wTtfbSum: number;
      wTtfbCnt: number;
    }
  >();
  for (const b of buckets) {
    const key = `${b.platform}:${b.model_id}`;
    const w = decayWeight(b.age_days);
    const a = acc.get(key) ?? {
      wSucc: 0,
      wFail: 0,
      wOut: 0,
      wLat: 0,
      wTtfbSum: 0,
      wTtfbCnt: 0,
    };
    a.wSucc += w * b.successes;
    a.wFail += w * (b.total - b.successes);
    a.wOut += w * b.succ_out;
    a.wLat += w * b.succ_lat;
    a.wTtfbSum += w * b.succ_ttfb_sum;
    a.wTtfbCnt += w * b.succ_ttfb_cnt;
    acc.set(key, a);
  }

  // Populate the temporary table with real statistics
  const insert = db.prepare(`
    INSERT OR REPLACE INTO model_stats_temp
    (platform, model_id, successes, failures, tokPerSec, avgTtfbMs, monthlyUsedTokens)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `);

  for (const [key, a] of acc) {
    const [platform, model_id] = key.split(":");
    const tokPerSec = a.wLat > 0 ? (a.wOut * 1000) / a.wLat : 0;
    const avgTtfbMs = a.wTtfbCnt > 0 ? a.wTtfbSum / a.wTtfbCnt : null;

    insert.run(
      platform,
      model_id,
      Math.round(a.wSucc),
      Math.round(a.wFail),
      tokPerSec,
      avgTtfbMs,
    );
  }

  // Also update the in-memory cache for existing functionality
  const next = new Map<string, ModelStats>();
  const statsRows = db
    .prepare(
      "SELECT platform, model_id, successes, failures, tokPerSec, avgTtfbMs FROM model_stats_temp",
    )
    .all();
  for (const row of statsRows as any[]) {
    next.set(`${row.platform}:${row.model_id}`, {
      successes: row.successes,
      failures: row.failures,
      tokPerSec: row.tokPerSec,
      avgTtfbMs: row.avgTtfbMs,
    });
  }

  statsCache = next;
  statsCacheTime = Date.now();
}

// Composite intelligence: size_label is the cross-provider capability tier
// (issue #135 — intelligence_rank is only meaningful within one provider), so
// tier dominates and intelligence_rank breaks ties inside a tier.
//
// When benchmark_score is available (populated from Artificial Analysis
// Intelligence Index), it's used directly — it's a better cross-provider
// signal because it's derived from actual benchmark performance rather than
// manual tier labels. The score [0, 100] is scaled to tier*1000 range so it
// composes cleanly with the existing min-max normalization.
const TIER_VALUE: Record<string, number> = {
  Frontier: 4,
  Large: 3,
  Medium: 2,
  Small: 1,
};
function intelligenceComposite(
  sizeLabel: string,
  intelligenceRank: number,
  benchmarkScore: number | null,
): number {
  // NOTE: benchmark_score must ONLY be populated from intelligence sources
  // (AA Intelligence Index — sole benchmark source after SWE-rebench/NIMStats purge).
  //
  // When benchmark_score is available, it's used directly — it's empirically
  // grounded and directly comparable across providers.
  if (benchmarkScore != null && benchmarkScore > 0) {
    // Scale to same range as tier-based composite (~0–4000) so the
    // scores blend naturally with any unscored models in the chain.
    // A score of 60 maps to 4000 (frontier-class), 3 maps to 200 (tiny).
    return benchmarkScore * (4000 / 60);
  }
  // No benchmark data → this model has UNKNOWN intelligence.
  // Use NEGATIVE composites so that after min-max normalization ALL
  // unscored models rank below ALL scored models. Within the no-data
  // pool, higher tier + lower rank = closer to 0 = higher composite.
  // Formula: -(maxTier*100 - tier*100 + intelligenceRank)
  // = -(400 - tier*100 + rank)
  // Examples: Frontier #1 = -1, Small #99 = -399, Small #50 = -350.
  // This leaves room for a future "boost" feature that can elevate
  // specific unscored models above their pool position.
  const tier = TIER_VALUE[sizeLabel] ?? 0;
  return -(4 * 100 - tier * 100 + intelligenceRank);
}

// Per-model axis values + the final score. `sampled` chooses Thompson sampling
// (for routing) vs. the expected value (for a stable dashboard display).
interface ScoredEntry {
  axes: {
    reliability: number;
    speed: number;
    intelligence: number;
    latency: number;
  };
  degradationFactor: number;
  boost: number;
  score: number;
}

function scoreChainEntry(
  entry: ChainRow,
  weights: RoutingWeights,
  intelMin: number,
  intelMax: number,
  speedMin: number,
  speedMax: number,
  latencyMin: number,
  latencyMax: number,
  sampled: boolean,
): ScoredEntry {
  const stats = statsCache?.get(`${entry.platform}:${entry.model_id}`);
  const successes = stats?.successes ?? 0;
  const failures = stats?.failures ?? 0;

  let reliability: number;
  if (sampled) {
    const { alpha, beta } = reliabilityPosterior(successes, failures);
    reliability = sampleBeta(alpha, beta);
  } else {
    reliability = expectedReliability(successes, failures);
  }

  // Compute a default speed score from the manual speed_rank so we have a
  // fallback when no real perf data exists yet. Uses the same min-max
  // normalisation pattern as intelligenceScore.
  const speedComposite = speedCompositeFromRank(
    entry.speed_rank,
    entry.size_label,
  );
  const defaultSpeed =
    speedMax > speedMin
      ? (speedComposite - speedMin) / (speedMax - speedMin)
      : 1; // single model or all equal → neutral-high

  // Heavy-weight the real measured tok/sec over the manual default.
  // When we have no data → pure default. Lots of data → 95 % real.
  const totalRequests = Math.round(successes + failures);
  const speed = heavyWeightedSpeedScore(
    stats?.tokPerSec ?? 0,
    totalRequests,
    defaultSpeed,
  );

  // Latency axis: TTFB, blended with manual size-based prior.
  const latencyComposite = latencyCompositeFromSize(entry.size_label);
  const defaultLatency =
    latencyMax > latencyMin
      ? (latencyComposite - latencyMin) / (latencyMax - latencyMin)
      : 1;

  const latency = heavyWeightedLatencyScore(
    stats?.avgTtfbMs ?? null,
    totalRequests,
    defaultLatency,
  );

  const intelligence = intelligenceScore(
    intelligenceComposite(
      entry.size_label,
      entry.intelligence_rank,
      entry.benchmark_score,
    ),
    intelMin,
    intelMax,
  );

  // budget system removed — headroom is no longer a factor
  const degradationFactor = getDegradationFactor(entry.model_db_id);
  const boost = getBoost(entry.model_db_id);

  const baseScore = combineScore(
    { reliability, speed, intelligence, latency },
    weights,
  );
  const score = baseScore * degradationFactor * boost;
  return {
    axes: { reliability, speed, intelligence, latency },
    degradationFactor,
    boost,
    score,
  };
}

/**
 * Order the enabled fallback chain for routing.
 *  - 'priority' strategy → legacy manual order + 429 penalty (unchanged).
 *  - bandit strategy      → Thompson-sampled convex score, manual priority as
 *                           the deterministic tiebreaker for (near-)equal scores.
 */
function orderChain(chain: ChainRow[], strategy: RoutingStrategy): ChainRow[] {
  const weights = weightsFor(strategy);
  if (!weights) {
    // Legacy priority mode: base priority + 429 penalty, ascending.
    return chain
      .map((e) => ({ e, eff: e.priority + getPenalty(e.model_db_id) }))
      .sort((a, b) => a.eff - b.eff || a.e.priority - b.e.priority)
      .map((x) => x.e);
  }

  // Intelligence composites for min-max normalization
  const intelComposites = chain.map((e) =>
    intelligenceComposite(e.size_label, e.intelligence_rank, e.benchmark_score),
  );
  const intelMin = intelComposites.length ? Math.min(...intelComposites) : 0;
  const intelMax = intelComposites.length ? Math.max(...intelComposites) : 0;

  // Speed composites for min-max normalization
  const speedComposites = chain.map((e) =>
    speedCompositeFromRank(e.speed_rank, e.size_label),
  );
  const speedMin = speedComposites.length ? Math.min(...speedComposites) : 0;
  const speedMax = speedComposites.length ? Math.max(...speedComposites) : 0;

  // Latency composites for min-max normalization
  const latencyComposites = chain.map((e) =>
    latencyCompositeFromSize(e.size_label),
  );
  const latencyMin = latencyComposites.length
    ? Math.min(...latencyComposites)
    : 0;
  const latencyMax = latencyComposites.length
    ? Math.max(...latencyComposites)
    : 0;

  return (
    chain
      .map((e) => ({
        e,
        s: scoreChainEntry(
          e,
          weights,
          intelMin,
          intelMax,
          speedMin,
          speedMax,
          latencyMin,
          latencyMax,
          true,
        ).score,
      }))
      // Higher score first; manual priority breaks ties so the chain still matters.
      .sort((a, b) => b.s - a.s || a.e.priority - b.e.priority)
      .map((x) => x.e)
  );
}

// –– Group-aware ordering –––––––––––––––––––––––––––––––––––––––––––––––
// When grouping is on, the chain is a list of groups. Intelligence is scored
// at the GROUP level (which group is smarter), speed/reliability at the
// provider level (which provider within the group is faster/more reliable).

function orderGroupChain(
  chain: GroupChainRow[],
  strategy: RoutingStrategy,
  providersByGroup = new Map<number, ProviderRow[]>(),
  weights: RoutingWeights = BANDIT_PRESETS.balanced,
  speedMin = 0,
  speedMax = 0,
  latencyMin = 0,
  latencyMax = 0,
  sampled = false,
): GroupChainRow[] {
  if (strategy === "priority") return chain;
  const groupComposites = chain.map((g) =>
    intelligenceComposite(
      g.size_label,
      g.intelligence_rank ?? 0,
      g.benchmark_score,
    ),
  );
  const groupIntelMin = groupComposites.length
    ? Math.min(...groupComposites)
    : 0;
  const groupIntelMax = groupComposites.length
    ? Math.max(...groupComposites)
    : 0;

  return [...chain].sort((a, b) => {
    const aScore = groupRepresentativeScore(
      a,
      providersByGroup.get(a.group_id) ?? [],
      weights,
      groupIntelMin,
      groupIntelMax,
      speedMin,
      speedMax,
      latencyMin,
      latencyMax,
      sampled,
    );
    const bScore = groupRepresentativeScore(
      b,
      providersByGroup.get(b.group_id) ?? [],
      weights,
      groupIntelMin,
      groupIntelMax,
      speedMin,
      speedMax,
      latencyMin,
      latencyMax,
      sampled,
    );
    return bScore - aScore || a.priority - b.priority;
  });
}

function groupRepresentativeScore(
  group: GroupChainRow,
  providers: ProviderRow[],
  weights: RoutingWeights,
  groupIntelMin: number,
  groupIntelMax: number,
  speedMin: number,
  speedMax: number,
  latencyMin: number,
  latencyMax: number,
  sampled: boolean,
): number {
  const intelligence = intelligenceScore(
    intelligenceComposite(
      group.size_label,
      group.intelligence_rank ?? 0,
      group.benchmark_score,
    ),
    groupIntelMin,
    groupIntelMax,
  );
  const bestProviderSubScore =
    providers.length > 0
      ? Math.max(
          ...providers.map(
            (provider) =>
              providerSubScore(
                provider,
                weights,
                speedMin,
                speedMax,
                latencyMin,
                latencyMax,
                sampled,
              ).subScore,
          ),
        )
      : 0;
  const providerWeight = weights.reliability + weights.speed + weights.latency;
  return (
    weights.intelligence * intelligence + providerWeight * bestProviderSubScore
  );
}

/** Compute a sub-score for a provider within a group.
 *  Zeroes out the intelligence axis (that's group-level) and
 *  re-normalises the remaining weights so they still sum to 1. */
function providerSubScore(
  provider: ProviderRow,
  weights: RoutingWeights,
  speedMin: number,
  speedMax: number,
  latencyMin: number,
  latencyMax: number,
  sampled: boolean,
): {
  subScore: number;
  axes: { reliability: number; speed: number; latency: number };
} {
  // Re-normalise without intelligence
  const remaining = weights.speed + weights.reliability + weights.latency;
  const subWeights: RoutingWeights =
    remaining > 0
      ? {
          speed: weights.speed / remaining,
          reliability: weights.reliability / remaining,
          intelligence: 0,
          latency: weights.latency / remaining,
        }
      : { speed: 1 / 3, reliability: 1 / 3, intelligence: 0, latency: 1 / 3 };

  const stats = statsCache?.get(`${provider.platform}:${provider.model_id}`);
  const successes = stats?.successes ?? 0;
  const failures = stats?.failures ?? 0;

  let reliability: number;
  if (sampled) {
    const { alpha, beta } = reliabilityPosterior(successes, failures);
    reliability = sampleBeta(alpha, beta);
  } else {
    reliability = expectedReliability(successes, failures);
  }

  const speedComposite = speedCompositeFromRank(
    provider.speed_rank,
    provider.size_label,
  );
  const speed =
    speedMax > speedMin
      ? (speedComposite - speedMin) / (speedMax - speedMin)
      : 1;

  const totalRequests = Math.round(successes + failures);
  const speedVal = heavyWeightedSpeedScore(
    stats?.tokPerSec ?? 0,
    totalRequests,
    speed,
  );

  const latencyComposite = latencyCompositeFromSize(provider.size_label);
  const defaultLatency =
    latencyMax > latencyMin
      ? (latencyComposite - latencyMin) / (latencyMax - latencyMin)
      : 1;
  const latency = heavyWeightedLatencyScore(
    stats?.avgTtfbMs ?? null,
    totalRequests,
    defaultLatency,
  );

  const degradationFactor = getDegradationFactor(provider.model_db_id);
  const boost = getBoost(provider.model_db_id);

  const baseSubScore = combineScore(
    { reliability, speed: speedVal, intelligence: 0, latency },
    subWeights,
  );
  const subScore = baseSubScore * degradationFactor * boost;

  return { subScore, axes: { reliability, speed: speedVal, latency } };
}

/**
 * Route a request to the best available model.
 *
 * Ordering depends on the configured strategy (see orderChain). Everything
 * downstream — key round-robin, cooldowns, token pre-checks, custom base_url
 * resolution, vision filtering, sticky sessions — is strategy-independent.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 * @param requireVision - only consider models that accept image input (#118)
 * @param requireTools - only consider models that emit structured tool_calls
 */
export interface RouteOptions {
  /** Don't fall through to other models when the preferred model's keys are exhausted. */
  pinMode?: boolean;
  /** Preferred model group for group-aware routing. Takes precedence over deriving the group from preferredModelDbId. */
  preferredGroupId?: number;
  /** Session key for key affinity — when set and key_affinity_enabled is true (or the provider has sticky_sessions_enabled), key selection is deterministic. */
  stickySessionKey?: string;
}

function pinnedModelExhaustedError(): Error {
  const err = new Error(
    "Pinned model exhausted — all keys for the requested model are rate-limited or on cooldown.",
  ) as any;
  err.code = "PINNED_MODEL_EXHAUSTED";
  err.status = 429;
  return err;
}

export function routeRequest(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  requireVision = false,
  requireTools = false,
  skipModels?: Set<number>,
  options?: RouteOptions,
): RouteResult {
  const db = getDb();

  const strategy = getRoutingStrategy();
  if (strategy !== "priority") refreshStatsCache(db);

  // –– GROUP-AWARE ROUTING –––––––––––––––––––––––––––––––––––––––––––––––––
  const groupingEnabled = getSetting("model_grouping_enabled") === "true";
  if (groupingEnabled) {
    // Query the group chain: fallback_config JOIN model_groups
    const groupChain = db
      .prepare(`
      SELECT fc.group_id, fc.priority, fc.enabled,
             mg.group_key, mg.display_name, mg.benchmark_score,
             mg.intelligence_rank, mg.size_label, mg.context_window,
             mg.max_output_tokens, mg.supports_vision, mg.supports_tools
      FROM fallback_config fc
      JOIN model_groups mg ON mg.id = fc.group_id
      WHERE fc.enabled = 1 AND mg.enabled = 1
    `)
      .all() as GroupChainRow[];

    // Pre-compute normalization ranges for provider sub-scoring
    // Load providers once and group them in memory to avoid N+1 queries on the
    // API hot path.
    const allGroupIds = groupChain.map((g) => g.group_id);
    let allProviders: ProviderRow[] = [];
    if (allGroupIds.length > 0) {
      const placeholders = allGroupIds.map(() => "?").join(", ");
      allProviders = db
        .prepare(`
        SELECT m.id as model_db_id, m.group_id, m.platform, m.model_id, m.display_name,
               m.speed_rank, m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
               m.key_id, m.enabled, m.supports_vision, m.supports_tools,
               m.context_window, m.benchmark_score, m.intelligence_rank, m.size_label,
               m.max_output_tokens
        FROM models m
        WHERE m.group_id IN (${placeholders}) AND m.enabled = 1
      `)
        .all(...allGroupIds) as ProviderRow[];
    }
    const providersByGroup = new Map<number, ProviderRow[]>();
    for (const provider of allProviders) {
      const providers = providersByGroup.get(provider.group_id);
      if (providers) providers.push(provider);
      else providersByGroup.set(provider.group_id, [provider]);
    }

    // Compute min/max for speed/latency normalization across all providers
    const speedComposites = allProviders.map((p) =>
      speedCompositeFromRank(p.speed_rank, p.size_label),
    );
    const speedMin = speedComposites.length ? Math.min(...speedComposites) : 0;
    const speedMax = speedComposites.length ? Math.max(...speedComposites) : 0;

    const latencyComposites = allProviders.map((p) =>
      latencyCompositeFromSize(p.size_label),
    );
    const latencyMin = latencyComposites.length
      ? Math.min(...latencyComposites)
      : 0;
    const latencyMax = latencyComposites.length
      ? Math.max(...latencyComposites)
      : 0;

    const weights = weightsFor(strategy) ?? BANDIT_PRESETS.balanced;
    const sortedGroupChain = orderGroupChain(
      groupChain,
      strategy,
      providersByGroup,
      weights,
      speedMin,
      speedMax,
      latencyMin,
      latencyMax,
      true,
    );
    const pinMode = options?.pinMode ?? false;

    // Sticky/group pinning: move the preferred group to the front. Explicit
    // group pins take precedence; deriving from preferredModelDbId preserves
    // sticky-session compatibility for older callers.
    let preferredGroupId = options?.preferredGroupId;
    if (preferredGroupId == null && preferredModelDbId) {
      // Find which group contains the preferred model
      const prefGroupRow = db
        .prepare("SELECT group_id FROM models WHERE id = ?")
        .get(preferredModelDbId) as { group_id: number | null } | undefined;
      preferredGroupId = prefGroupRow?.group_id ?? undefined;
    }
    if (preferredGroupId != null) {
      const idx = sortedGroupChain.findIndex(
        (g) => g.group_id === preferredGroupId,
      );
      if (idx > 0) {
        const [preferred] = sortedGroupChain.splice(idx, 1);
        sortedGroupChain.unshift(preferred);
      } else if (idx < 0 && pinMode) {
        throw pinnedModelExhaustedError();
      }
    }
    const routeGroupChain =
      pinMode && preferredGroupId != null
        ? sortedGroupChain.filter((g) => g.group_id === preferredGroupId)
        : sortedGroupChain;
    if (pinMode && preferredGroupId != null && routeGroupChain.length === 0) {
      throw pinnedModelExhaustedError();
    }

    for (const group of routeGroupChain) {
      const isPreferredGroup =
        preferredGroupId != null && group.group_id === preferredGroupId;
      // Filter by vision/tools/context at the GROUP level
      if (requireVision && !group.supports_vision) {
        if (pinMode && isPreferredGroup) throw pinnedModelExhaustedError();
        continue;
      }
      if (requireTools && !group.supports_tools) {
        if (pinMode && isPreferredGroup) throw pinnedModelExhaustedError();
        continue;
      }
      if (
        group.context_window != null &&
        estimatedTokens > group.context_window
      ) {
        if (pinMode && isPreferredGroup) throw pinnedModelExhaustedError();
        continue;
      }

      const providers = providersByGroup.get(group.group_id) ?? [];

      if (providers.length === 0) {
        if (pinMode && isPreferredGroup) throw pinnedModelExhaustedError();
        continue;
      }

      // Score and sort providers within this group
      const weightsForSub = weightsFor(strategy) ?? BANDIT_PRESETS.balanced;
      const providersScored = providers
        .map((p) => {
          const { subScore, axes } = providerSubScore(
            p,
            weightsForSub,
            speedMin,
            speedMax,
            latencyMin,
            latencyMax,
            true,
          );
          return { p, subScore, axes };
        })
        .sort(
          (a, b) => b.subScore - a.subScore || a.p.speed_rank - b.p.speed_rank,
        );

      for (const { p: provider } of providersScored) {
        // Models the caller has ruled out for this request
        if (skipModels?.has(provider.model_db_id)) continue;

        // Same provider/key resolution as flat chain
        const prov = buildProviderFor(provider.platform);
        if (!prov) continue;

        const keys = db
          .prepare(
            "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown', 'error')",
          )
          .all(provider.platform) as KeyRow[];

        if (keys.length === 0) {
          continue;
        }

        // Key health filtering
        const heartbeatEnabled = isHeartbeatEnabled();
        const healthyKeys = keys.filter((k) =>
          isKeyHealthy(k.id, provider.model_id),
        );

        if (heartbeatEnabled && healthyKeys.length === 0) {
          continue;
        }

        const unhealthyKeys = heartbeatEnabled
          ? []
          : keys.filter((k) => !isKeyHealthy(k.id, provider.model_id));

        // Key ordering
        const rrKey = `${provider.platform}:${provider.model_id}`;
        const keyAffinityEnabled = getFeatureSetting(
          "key_affinity_enabled",
        ) as boolean;
        let providerStickyEnabled = false;
        if (!keyAffinityEnabled) {
          const stickyRow = db
            .prepare(
              "SELECT sticky_sessions_enabled FROM custom_providers WHERE slug = ?",
            )
            .get(provider.platform) as
            | { sticky_sessions_enabled: number }
            | undefined;
          providerStickyEnabled = stickyRow?.sticky_sessions_enabled === 1;
        }
        const useKeyAffinity =
          (keyAffinityEnabled ||
            (providerStickyEnabled && options?.stickySessionKey)) &&
          options?.stickySessionKey;

        let keyOrder: KeyRow[];
        let idx: number;
        let rrIdx = 0;
        if (useKeyAffinity) {
          keyOrder = [...healthyKeys, ...unhealthyKeys];
          const hash = crypto
            .createHash("sha1")
            .update(options!.stickySessionKey!)
            .digest();
          const hashInt = hash.readUInt32BE(0);
          idx = hashInt % keyOrder.length;
        } else {
          rrIdx = roundRobinIndex.get(rrKey) ?? 0;
          // When heartbeat is enabled, shuffle healthy keys by ping latency
          // with weighted randomness so faster keys get more traffic
          const orderedHealthyKeys = heartbeatEnabled
            ? pingWeightedShuffle(healthyKeys, provider.model_id)
            : rotateArray(healthyKeys, rrIdx);
          keyOrder = [
            ...orderedHealthyKeys,
            ...rotateArray(unhealthyKeys, rrIdx),
          ];
          idx = 0;
        }

        for (let attempt = 0; attempt < keyOrder.length; attempt++) {
          const actualIdx = useKeyAffinity
            ? (idx + attempt) % keyOrder.length
            : attempt;
          const key = keyOrder[actualIdx];

          const skipId = `${provider.platform}:${provider.model_id}:${key.id}`;
          if (skipKeys?.has(skipId)) continue;
          if (isExhausted(key.id, provider.model_id)) continue;

          // Parallel request gating
          const cp = db
            .prepare(
              "SELECT max_parallel_requests FROM custom_providers WHERE slug = ?",
            )
            .get(provider.platform) as
            | { max_parallel_requests: number | null }
            | undefined;
          const maxPar = cp?.max_parallel_requests ?? null;
          if (!tryReserveSlot(provider.platform, maxPar)) continue;

          let decryptedKey: string;
          try {
            decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
          } catch {
            db.prepare(
              "UPDATE api_keys SET status = 'invalid', enabled = 0, last_checked_at = datetime('now') WHERE id = ?",
            ).run(key.id);
            releaseSlot(provider.platform);
            continue;
          }

          const release = () => releaseSlot(provider.platform);

          if (useKeyAffinity) {
            console.log(
              `[Proxy] Key affinity selected key ${key.id} for session ${options!.stickySessionKey!.slice(0, 8)}`,
            );
            publish({
              type: "routing.key_affinity_selected",
              id: "",
              sessionKey: options!.stickySessionKey!.slice(0, 8),
              keyId: key.id,
              model: provider.model_id,
              at: Date.now(),
            });
          }

          return {
            provider: prov,
            modelId: provider.model_id,
            modelDbId: provider.model_db_id,
            apiKey: decryptedKey,
            keyId: key.id,
            platform: provider.platform,
            displayName: provider.display_name,
            rpdLimit: provider.rpd_limit,
            tpdLimit: provider.tpd_limit,
            maxOutputTokens: provider.max_output_tokens,
            release,
            useProxy: key.use_proxy === 1,
            transportId: transportIdFromUseProxy(key.use_proxy === 1),
            groupId: group.group_id,
          };
        }

        // If we reach here, this provider has NO available keys.
        if (!useKeyAffinity) {
          roundRobinIndex.set(rrKey, (idx + 1) % keyOrder.length);
        }
      }
      // If we reach here, all providers in this group are exhausted. In pin
      // mode, the preferred group is the full allowed surface; otherwise try
      // the next group in the fallback chain.
      if (pinMode && isPreferredGroup) throw pinnedModelExhaustedError();
    }

    // All groups exhausted
    const err = new Error(
      "All models exhausted. Add more API keys or check provider status.",
    ) as any;
    err.status = 429;
    throw err;
  }

  // –– FLAT CHAIN (LEGACY) –––––––––––––––––––––––––––––––––––––––––––––––––––
  // Get the enabled fallback chain joined with the fields the scorer needs.
  const chain = db
    .prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.max_output_tokens, m.key_id,
           m.benchmark_score
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE fc.enabled = 1 AND m.enabled = 1
  `)
    .all() as ChainRow[];

  const sortedChain = orderChain(chain, strategy);

  // Sticky session: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(
      (e) => e.model_db_id === preferredModelDbId,
    );
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  const pinMode = options?.pinMode ?? false;

  for (const entry of sortedChain) {
    // Models the caller has ruled out for this request — e.g. a 404
    // "model removed upstream" already seen this request: trying the same
    // model again on a different key would just burn another attempt on the
    // same dead route (PR #111, credits @barbotkonv).
    if (skipModels?.has(entry.model_db_id)) continue;

    // Vision requests skip text-only models — including a sticky/preferred one,
    // which is correct: don't pin an image turn to a model that can't see it.
    if (requireVision && !entry.supports_vision) continue;

    // Tool-bearing requests skip models that can't emit structured tool_calls.
    // A model that "answers" a tool request with the call serialized as text
    // looks successful at the transport level while the client's harness sees
    // nothing — worse than a failover. Applies to sticky models too, same
    // reasoning as vision above.
    if (requireTools && !entry.supports_tools) continue;

    // Context-aware routing: skip a model whose context window can't hold the
    // request, so a large prompt never selects a small-context model and burns
    // a failover hop on a 413 "request too large" (#167). Only enforced when we
    // know the model's window; estimatedTokens already includes the reserved
    // output (max_tokens), so this is the total-context check the model must
    // satisfy. A 413 that slips through is still retryable downstream, and the
    // failed model is put on cooldown — so this is a fast-path, not the only
    // guard. If every model is too small, the loop falls through and the caller
    // gets the normal "all models exhausted" error rather than a wasted sweep.
    if (entry.context_window != null && estimatedTokens > entry.context_window)
      continue;

    // Same guard for a model with a small per-minute token budget: a single
    // request that alone exceeds tpm_limit can never fit one minute of quota and
    // returns a guaranteed 413 (e.g. Groq gpt-oss-120b: 131k context but 8k TPM).
    // estimatedTokens already includes reserved output, mirroring the check above.
    if (entry.tpm_limit != null && estimatedTokens > entry.tpm_limit) continue;

    // Resolve the provider for this platform. Built-in platforms return their
    // registered singleton; custom slugs look up their base URL from
    // custom_providers. If neither resolves (e.g. the custom provider row
    // was deleted), skip the model.
    const provider = buildProviderFor(entry.platform);
    if (!provider) continue;
    // Get enabled keys that have not already failed validation or decryption.
    const keys = db
      .prepare(
        "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown', 'error')",
      )
      .all(entry.platform) as KeyRow[];

    if (keys.length === 0) {
      if (
        pinMode &&
        preferredModelDbId &&
        entry.model_db_id === preferredModelDbId
      ) {
        const pinErr = new Error(
          "Pinned model exhausted — all keys for the requested model are rate-limited or on cooldown.",
        ) as any;
        pinErr.code = "PINNED_MODEL_EXHAUSTED";
        pinErr.status = 429;
        throw pinErr;
      }
      continue;
    }

    // Get limits once for this model
    const limits = {
      rpm: entry.rpm_limit,
      rpd: entry.rpd_limit,
      tpm: entry.tpm_limit,
      tpd: entry.tpd_limit,
    };

    // Try all keys for this model before giving up on it.
    const rrKey = `${entry.platform}:${entry.model_id}`;
    const keyAffinityEnabled = getFeatureSetting(
      "key_affinity_enabled",
    ) as boolean;
    // Backward compat: when global key affinity is off, fall back to per-provider
    // sticky_sessions_enabled column for custom providers.
    let providerStickyEnabled = false;
    if (!keyAffinityEnabled) {
      const stickyRow = db
        .prepare(
          "SELECT sticky_sessions_enabled FROM custom_providers WHERE slug = ?",
        )
        .get(entry.platform) as { sticky_sessions_enabled: number } | undefined;
      providerStickyEnabled = stickyRow?.sticky_sessions_enabled === 1;
    }
    const useKeyAffinity =
      (keyAffinityEnabled ||
        (providerStickyEnabled && options?.stickySessionKey)) &&
      options?.stickySessionKey; // Only use affinity if we have a valid session key

    // ── Key health filtering ──
    // When the heartbeat is enabled, only keys that have been prewarmed
    // and confirmed healthy by heartbeat pings are eligible for routing.
    // Cold keys (never pinged) and unhealthy keys (failed pings) are
    // excluded — they must first pass a heartbeat cycle to prove health.
    // When heartbeat is disabled, all keys are usable (backward compat).
    const heartbeatEnabled = isHeartbeatEnabled();
    const healthyKeys = keys.filter((k) => isKeyHealthy(k.id, entry.model_id));

    if (heartbeatEnabled && healthyKeys.length === 0) {
      // No prewarmed healthy keys for this model — skip to the next model.
      // In pin mode, throw immediately instead of falling through silently.
      if (
        pinMode &&
        preferredModelDbId &&
        entry.model_db_id === preferredModelDbId
      ) {
        const pinErr = new Error(
          "Pinned model exhausted — all keys for the requested model are rate-limited or on cooldown.",
        ) as any;
        pinErr.code = "PINNED_MODEL_EXHAUSTED";
        pinErr.status = 429;
        throw pinErr;
      }
      continue;
    }

    // Split keys by health status so healthy keys are ALWAYS tried first,
    // regardless of round-robin offset. Apply round-robin within each group
    // independently to maintain fair distribution while respecting health.
    const unhealthyKeys = heartbeatEnabled
      ? []
      : keys.filter((k) => !isKeyHealthy(k.id, entry.model_id));

    // Build the key ordering array and starting index.
    // For key affinity: concatenate healthy+unhealthy and hash into it.
    // For round-robin: rotate within each health group independently so
    // healthy keys are ALWAYS tried first regardless of the offset.

    let keyOrder: KeyRow[];
    let idx: number;
    let rrIdx = 0; // For round-robin increment tracking
    if (useKeyAffinity) {
      keyOrder = [...healthyKeys, ...unhealthyKeys];
      const hash = crypto
        .createHash("sha1")
        .update(options!.stickySessionKey!)
        .digest();
      const hashInt = hash.readUInt32BE(0);
      idx = hashInt % keyOrder.length;
    } else {
      rrIdx = roundRobinIndex.get(rrKey) ?? 0;
      // When heartbeat is enabled, shuffle healthy keys by ping latency
      // with weighted randomness so faster keys get more traffic
      const orderedHealthyKeys = heartbeatEnabled
        ? pingWeightedShuffle(healthyKeys, entry.model_id)
        : rotateArray(healthyKeys, rrIdx);
      keyOrder = [...orderedHealthyKeys, ...rotateArray(unhealthyKeys, rrIdx)];
      idx = 0; // start from beginning — healthy-first guaranteed by construction
    }

    for (let attempt = 0; attempt < keyOrder.length; attempt++) {
      const actualIdx = useKeyAffinity
        ? (idx + attempt) % keyOrder.length
        : attempt;
      const key = keyOrder[actualIdx];

      const skipId = `${entry.platform}:${entry.model_id}:${key.id}`;

      // skipKeys accumulation gates attempts to avoid
      // re-hammering the same key within one request sweep.
      if (skipKeys?.has(skipId)) continue;
      if (isExhausted(key.id, entry.model_id)) continue;

      // Rate-limit pre-checks removed. Key health is determined by the
      // heartbeat system (per-key degradation) instead of predictive quota
      // tracking. The proxy's retry loop + cooldown-on-failure handles any
      // actual 429s that slip through.

      // provider was already resolved above; if it came back undefined (e.g.
      // a custom provider row was deleted), we already continued.

      // We found a working key for this model!
      if (!useKeyAffinity) {
        roundRobinIndex.set(rrKey, rrIdx + attempt + 1);
      }

      // ── Parallel request gating (provider-level) ──
      // Check if this provider has a concurrency cap and try to reserve a slot.
      const cp = db
        .prepare(
          "SELECT max_parallel_requests FROM custom_providers WHERE slug = ?",
        )
        .get(entry.platform) as
        | { max_parallel_requests: number | null }
        | undefined;
      const maxPar = cp?.max_parallel_requests ?? null;
      if (!tryReserveSlot(entry.platform, maxPar)) continue; // at capacity, try next model
      let decryptedKey: string;
      try {
        decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
      } catch {
        // Decrypt failure is permanent — disable the key so it's never
        // selected again (Fix 1 includes status='error' in routing).
        db.prepare(
          "UPDATE api_keys SET status = 'invalid', enabled = 0, last_checked_at = datetime('now') WHERE id = ?",
        ).run(key.id);
        releaseSlot(entry.platform);
        continue;
      }

      // Build the release function so callers can decrement the slot.
      const release = () => releaseSlot(entry.platform);

      if (useKeyAffinity) {
        console.log(
          `[Proxy] Key affinity selected key ${key.id} for session ${options!.stickySessionKey!.slice(0, 8)}`,
        );
        publish({
          type: "routing.key_affinity_selected",
          id: "",
          sessionKey: options!.stickySessionKey!.slice(0, 8),
          keyId: key.id,
          model: entry.model_id,
          at: Date.now(),
        });
      }

      return {
        provider: provider,
        modelId: entry.model_id,
        modelDbId: entry.model_db_id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: entry.platform,
        displayName: entry.display_name,
        rpdLimit: limits.rpd,
        tpdLimit: limits.tpd,
        maxOutputTokens: entry.max_output_tokens,
        release,
        useProxy: key.use_proxy === 1,
        transportId: transportIdFromUseProxy(key.use_proxy === 1),
      };
    }

    // If we reach here, this specific model has NO available keys.
    // Update round-robin index even if we failed so we don't get stuck.
    if (!useKeyAffinity) {
      roundRobinIndex.set(rrKey, (idx + 1) % keyOrder.length);
    }

    // In pin mode, don't fall through to the next model.
    if (
      pinMode &&
      preferredModelDbId &&
      entry.model_db_id === preferredModelDbId
    ) {
      const pinErr = new Error(
        "Pinned model exhausted — all keys for the requested model are rate-limited or on cooldown.",
      ) as any;
      pinErr.code = "PINNED_MODEL_EXHAUSTED";
      pinErr.status = 429;
      throw pinErr;
    }

    // We don't explicitly penalize the model here because the fact that we
    // couldn't find a key means we will naturally move to the next model
    // in the sortedChain for THIS specific request.
  }

  const err = new Error(
    "All models exhausted. Add more API keys or check provider status.",
  ) as any;
  err.status = 429;
  throw err;
}

/**
 * Per-model routing scores for the dashboard. Deterministic (expected
 * reliability, not sampled) so the table is stable between polls. Returns the
 * axis breakdown plus the final score under the active strategy's weights.
 */
export interface RoutingScore {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  reliability: number;
  speed: number;
  intelligence: number;
  latency: number;
  degradationFactor: number;
  boost: number;
  score: number;
  totalRequests: number; // decay-weighted observations
}

// Grouped routing scores for the dashboard when grouping is enabled
export interface GroupedRoutingScore {
  groupKey: string;
  groupId: number;
  groupScore: number;
  providers: Array<{
    modelDbId: number;
    platform: string;
    modelId: string;
    subScore: number;
    degradation: { penalty: number; tier: string };
  }>;
}

export function getRoutingScores(): {
  strategy: RoutingStrategy;
  weights: RoutingWeights | null;
  scores: RoutingScore[];
  groupedScores?: GroupedRoutingScore[];
} {
  const db = getDb();
  const strategy = getRoutingStrategy();
  refreshStatsCache(db);

  const chain = db
    .prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank, m.speed_rank,
           m.size_label,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.benchmark_score, m.context_window, m.max_output_tokens
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE fc.enabled = 1 AND m.enabled = 1
  `)
    .all() as ChainRow[];

  // For display we score under 'balanced' weights when in priority mode, so the
  // table still shows a meaningful ranking even with the bandit turned off.
  const weights = weightsFor(strategy) ?? BANDIT_PRESETS.balanced;
  const composites = chain.map((e) =>
    intelligenceComposite(e.size_label, e.intelligence_rank, e.benchmark_score),
  );
  const intelMin = composites.length ? Math.min(...composites) : 0;
  const intelMax = composites.length ? Math.max(...composites) : 0;

  // Speed composites for min-max normalization
  const speedComposites = chain.map((e) =>
    speedCompositeFromRank(e.speed_rank, e.size_label),
  );
  const speedMin = speedComposites.length ? Math.min(...speedComposites) : 0;
  const speedMax = speedComposites.length ? Math.max(...speedComposites) : 0;

  // Latency composites for min-max normalization
  const latencyComposites = chain.map((e) =>
    latencyCompositeFromSize(e.size_label),
  );
  const latencyMin = latencyComposites.length
    ? Math.min(...latencyComposites)
    : 0;
  const latencyMax = latencyComposites.length
    ? Math.max(...latencyComposites)
    : 0;

  const scores: RoutingScore[] = chain
    .map((entry) => {
      const scored = scoreChainEntry(
        entry,
        weights,
        intelMin,
        intelMax,
        speedMin,
        speedMax,
        latencyMin,
        latencyMax,
        false,
      );
      const stats = statsCache?.get(`${entry.platform}:${entry.model_id}`);
      return {
        modelDbId: entry.model_db_id,
        platform: entry.platform,
        modelId: entry.model_id,
        displayName: entry.display_name,
        enabled: true,
        reliability: scored.axes.reliability,
        speed: scored.axes.speed,
        intelligence: scored.axes.intelligence,
        latency: scored.axes.latency,
        degradationFactor: scored.degradationFactor,
        boost: scored.boost,
        score: scored.score,
        totalRequests: Math.round(
          (stats?.successes ?? 0) + (stats?.failures ?? 0),
        ),
      };
    })
    .sort((a, b) => b.score - a.score);

  // –– Grouped scores when grouping is enabled –––––––––––––––––––––––––––
  const groupingEnabled = getSetting("model_grouping_enabled") === "true";
  let groupedScores: GroupedRoutingScore[] | undefined;
  if (groupingEnabled) {
    // Query groups with their fallback_config priority
    const groupChain = db
      .prepare(`
      SELECT fc.group_id, fc.priority, fc.enabled,
             mg.group_key, mg.display_name, mg.benchmark_score,
             mg.intelligence_rank, mg.size_label, mg.context_window,
             mg.max_output_tokens, mg.supports_vision, mg.supports_tools
      FROM fallback_config fc
      JOIN model_groups mg ON mg.id = fc.group_id
      WHERE fc.enabled = 1 AND mg.enabled = 1
    `)
      .all() as GroupChainRow[];

    // Collect all providers for normalization ranges
    let allProviders: ProviderRow[] = [];
    if (groupChain.length > 0) {
      const placeholders = groupChain.map(() => "?").join(", ");
      allProviders = db
        .prepare(`
        SELECT m.id as model_db_id, m.group_id, m.platform, m.model_id, m.display_name,
               m.speed_rank, m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
               m.key_id, m.enabled, m.supports_vision, m.supports_tools,
               m.context_window, m.benchmark_score, m.intelligence_rank, m.size_label,
               m.max_output_tokens
        FROM models m
        WHERE m.group_id IN (${placeholders}) AND m.enabled = 1
      `)
        .all(...groupChain.map((g) => g.group_id)) as ProviderRow[];
    }
    const providersByGroup = new Map<number, ProviderRow[]>();
    for (const provider of allProviders) {
      const providers = providersByGroup.get(provider.group_id);
      if (providers) providers.push(provider);
      else providersByGroup.set(provider.group_id, [provider]);
    }

    // Min-max for provider sub-scoring
    const speedComposites = allProviders.map((p) =>
      speedCompositeFromRank(p.speed_rank, p.size_label),
    );
    const speedMin = speedComposites.length ? Math.min(...speedComposites) : 0;
    const speedMax = speedComposites.length ? Math.max(...speedComposites) : 0;

    const latencyComposites = allProviders.map((p) =>
      latencyCompositeFromSize(p.size_label),
    );
    const latencyMin = latencyComposites.length
      ? Math.min(...latencyComposites)
      : 0;
    const latencyMax = latencyComposites.length
      ? Math.max(...latencyComposites)
      : 0;

    const weightsForSub = weightsFor(strategy) ?? BANDIT_PRESETS.balanced;
    const sortedGroups = orderGroupChain(
      groupChain,
      strategy,
      providersByGroup,
      weightsForSub,
      speedMin,
      speedMax,
      latencyMin,
      latencyMax,
      false,
    );

    groupedScores = [];
    // Compute intelligence composites for all groups and min-max normalize
    const groupComposites = sortedGroups.map((g) =>
      intelligenceComposite(
        g.size_label,
        g.intelligence_rank ?? 0,
        g.benchmark_score,
      ),
    );
    const groupIntelMin = groupComposites.length
      ? Math.min(...groupComposites)
      : 0;
    const groupIntelMax = groupComposites.length
      ? Math.max(...groupComposites)
      : 0;

    for (const group of sortedGroups) {
      const providers = providersByGroup.get(group.group_id) ?? [];
      if (providers.length === 0) continue;

      // Score providers within this group (deterministic, not sampled)
      const providersScored = providers
        .map((p) => {
          const { subScore, axes } = providerSubScore(
            p,
            weightsForSub,
            speedMin,
            speedMax,
            latencyMin,
            latencyMax,
            false,
          );
          const degradationState = getAllStatesView().get(p.model_db_id);
          return {
            modelDbId: p.model_db_id,
            platform: p.platform,
            modelId: p.model_id,
            subScore,
            degradation: {
              penalty: degradationState?.penalty ?? 0,
              tier: degradationState?.tier ?? "healthy",
            },
          };
        })
        .sort((a, b) => b.subScore - a.subScore);

      const groupScore = groupRepresentativeScore(
        group,
        providers,
        weightsForSub,
        groupIntelMin,
        groupIntelMax,
        speedMin,
        speedMax,
        latencyMin,
        latencyMax,
        false,
      );

      groupedScores.push({
        groupKey: group.group_key,
        groupId: group.group_id,
        groupScore,
        providers: providersScored,
      });
    }
  }

  return { strategy, weights: weightsFor(strategy), scores, groupedScores };
}

// Whether at least one vision-capable model is enabled in the fallback chain.
// Used to give image requests a clear "enable a vision model" error instead of
// the generic exhaustion message when none is configured (#118, #125).
export function hasEnabledVisionModel(): boolean {
  const db = getDb();
  const row = db
    .prepare(`
    SELECT COUNT(*) as cnt
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE fc.enabled = 1 AND m.enabled = 1
      AND m.supports_vision = 1
  `)
    .get() as { cnt: number };
  return row.cnt > 0;
}

// Whether at least one tool-capable model is enabled in the fallback chain.
// Same role as hasEnabledVisionModel: a clear up-front error for tool-bearing
// requests beats routing them to a model that mangles the tool call.
export function hasEnabledToolsModel(): boolean {
  const db = getDb();
  const row = db
    .prepare(`
    SELECT COUNT(*) as cnt
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE fc.enabled = 1 AND m.enabled = 1
      AND m.supports_tools = 1
  `)
    .get() as { cnt: number };
  return row.cnt > 0;
}
