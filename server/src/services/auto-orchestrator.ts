import {
  AUTO_ARMS,
  type ProviderRoutingStrategy,
} from "@animarouter/shared/types.js";
import { getDb } from "../db/index.js";
import {
  BANDIT_PRESETS,
  combineScore,
  type RoutingStrategy,
  type RoutingWeights,
  sampleBeta,
} from "./scoring.js";

/**
 * Thompson-sampled Auto meta-bandit orchestrator.
 *
 * Each platform independently drives a 5-armed bandit. The arms are
 * AUTO_ARMS (balanced, smartest, fastest, reliable, racing). Reward is a
 * composite of reliability, latency, and throughput derived from live
 * `model_stats_temp` telemetry. Pseudo-counts are recomputed on every call
 * (no separate reward table).
 *
 * The same arm is cached per platform for a 60-second jittered window so a
 * burst of requests in a single window does not thrash the dispatch order.
 */

const SPARSE_THRESHOLD = 10; // total observations below this → uniform prior
const RESAMPLE_WINDOW_MS = 60_000; // 60s re-sample window per platform
const JITTER_MS = 5_000; // ±5s jitter so concurrent platforms desync

interface PlatformSample {
  arm: RoutingStrategy;
  sampledAt: number;
  nextResampleAt: number;
}

const sampleCache = new Map<string, PlatformSample>();

/**
 * Reset the per-platform re-sample cache — useful for tests that want
 * deterministic behaviour between cases.
 */
export function resetAutoOrchestratorCache(): void {
  sampleCache.clear();
}

/**
 * Aggregated telemetry for a platform across all its models.
 */
export interface PlatformTelemetry {
  totalSuccesses: number;
  totalFailures: number;
  totalTokPerSec: number;
  totalAvgTtfbMs: number;
  totalAvgTtfbMsCount: number;
  observationCount: number;
}

const TELEMETRY_SQL = `
  SELECT
    COALESCE(SUM(successes), 0)       AS totalSuccesses,
    COALESCE(SUM(failures), 0)        AS totalFailures,
    COALESCE(SUM(tokPerSec), 0)       AS totalTokPerSec,
    COALESCE(SUM(avgTtfbMs), 0)       AS totalAvgTtfbMs,
    COALESCE(SUM(CASE WHEN avgTtfbMs IS NOT NULL THEN 1 ELSE 0 END), 0)
                                      AS totalAvgTtfbMsCount
  FROM model_stats_temp
  WHERE platform = ?;
`;

function getPlatformTelemetry(platform: string): PlatformTelemetry {
  const db = getDb();
  const row = db.prepare(TELEMETRY_SQL).get(platform) as {
    totalSuccesses: number;
    totalFailures: number;
    totalTokPerSec: number;
    totalAvgTtfbMs: number;
    totalAvgTtfbMsCount: number;
  };
  const totalSuccesses = row?.totalSuccesses ?? 0;
  const totalFailures = row?.totalFailures ?? 0;
  return {
    totalSuccesses,
    totalFailures,
    totalTokPerSec: row?.totalTokPerSec ?? 0,
    totalAvgTtfbMs: row?.totalAvgTtfbMs ?? 0,
    totalAvgTtfbMsCount: row?.totalAvgTtfbMsCount ?? 0,
    observationCount: totalSuccesses + totalFailures,
  };
}

/**
 * Reward in [0,1] for an arm, computed from the platform aggregate telemetry.
 *
 * Each arm scores the SAME telemetry against its OWN weight vector via
 * combineScore. Arms whose blend aligns with the platform's observed signal
 * (e.g. 'reliable' when the platform is rock-solid) accumulate higher
 * rewards; arms whose premium axes are weak under the telemetry fall behind.
 * That spread is what drives Thompson sampling to favour an arm.
 */
function armReward(
  arm: ProviderRoutingStrategy,
  tel: PlatformTelemetry,
): number {
  const weights: RoutingWeights =
    BANDIT_PRESETS[arm as keyof typeof BANDIT_PRESETS] ??
    BANDIT_PRESETS.balanced;

  const reliability =
    tel.totalSuccesses + tel.totalFailures > 0
      ? tel.totalSuccesses / (tel.totalSuccesses + tel.totalFailures)
      : 0.5;

  const speedScore = Math.min(1, tel.totalTokPerSec / 200);

  const avgTtfbMs =
    tel.totalAvgTtfbMsCount > 0
      ? tel.totalAvgTtfbMs / tel.totalAvgTtfbMsCount
      : null;
  const latencyScore =
    avgTtfbMs === null
      ? 0.6
      : avgTtfbMs <= 300
        ? 1
        : avgTtfbMs >= 5000
          ? 0
          : 1 - (avgTtfbMs - 300) / (5000 - 300);

  // `model_stats_temp` has no intelligence axis, so we use the neutral prior.
  // This is consistent with BANDIT_PRESETS which is also neutral on intel.
  const intelScore = 0.5;

  return combineScore(
    {
      reliability,
      speed: speedScore,
      intelligence: intelScore,
      latency: latencyScore,
    },
    weights,
  );
}

/**
 * Thompson-sample one arm for the platform.
 *
 * For each arm, compute a reward from the platform aggregate telemetry,
 * translate into Beta pseudo-counts, draw r_i ~ Beta(alpha_i, beta_i), and
 * pick the argmax.
 *
 * Sparse-data fallback (total observations < SPARSE_THRESHOLD): use a
 * uniform Beta(1,1) prior on every arm so all arms have equal selection
 * probability.
 */
export function selectAutoStrategy(platform: string): RoutingStrategy {
  // Re-sample window check
  const cached = sampleCache.get(platform);
  const now = Date.now();
  if (cached && cached.nextResampleAt > now) {
    return cached.arm;
  }

  const tel = getPlatformTelemetry(platform);
  const sparse = tel.observationCount < SPARSE_THRESHOLD;

  let bestArm: RoutingStrategy = AUTO_ARMS[0];
  let bestDraw = -Infinity;

  for (const arm of AUTO_ARMS) {
    let alpha: number;
    let beta: number;
    if (sparse) {
      // Uniform prior — no information to exploit
      alpha = 1;
      beta = 1;
    } else {
      // Pseudo-counts: prior reward accumulated from telemetry,
      // transformed into Beta pseudo-counts.
      const reward = armReward(arm, tel);
      const pseudoTotal = Math.max(1, tel.observationCount);
      alpha = Math.max(1, reward * pseudoTotal + 1);
      beta = Math.max(1, (1 - reward) * pseudoTotal + 1);
    }

    const draw = sampleBeta(alpha, beta);
    if (draw > bestDraw) {
      bestDraw = draw;
      bestArm = arm;
    }
  }

  const sampledAt = now;
  const jitter = Math.floor(Math.random() * (JITTER_MS * 2)) - JITTER_MS;
  sampleCache.set(platform, {
    arm: bestArm,
    sampledAt,
    nextResampleAt: sampledAt + RESAMPLE_WINDOW_MS + jitter,
  });

  return bestArm;
}

/**
 * Tolerant outcome recorder.
 *
 * The orchestrator recomputes pseudo-counts from `model_stats_temp` directly,
 * so this function is an intentional no-op accumulator for callers that want
 * to record a per-arm signal. It tolerates unknown platforms, unknown arms,
 * and any reward value without throwing.
 */
export function recordAutoOutcome(
  _platform: string,
  _arm: string,
  _reward: number,
): void {
  void _platform;
  void _arm;
  void _reward;
}
