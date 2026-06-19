// ── Bandit routing score ────────────────────────────────────────────────────
//
// A redesign of the analytics-driven router. Instead of summing a pile of
// hand-tuned, dimensionally-incompatible bonuses (a probability + a raw latency
// term + an intelligence term, each hand-capped to keep orderings sane), every
// signal here is normalized to [0, 1] and combined as a CONVEX COMBINATION:
//
//   base = w_rel·reliability + w_speed·speed + w_intel·intelligence
//          (weights are a preset that sums to 1, so base ∈ [0, 1])
//
// Two always-on GUARDRAILS then multiply the base — they never reorder good
// models against each other, they only pull a model down as it gets dangerous:
//
//   effective = base × headroomFactor × rateLimitFactor
//
//   headroomFactor  → protects a model that is nearly out of its free quota
//   rateLimitFactor → demotes a model that is currently throwing 429s
//
// Reliability is drawn from a Beta posterior (Thompson sampling) so exploration
// is automatic and proportional to uncertainty — a model is never permanently
// frozen out after a couple of failures. Speed and intelligence are
// deterministic. The result stays in a bounded, interpretable range and no term
// needs a manual cap to "still beat a 0%-success model".

export interface RoutingWeights {
  reliability: number;
  speed: number;
  intelligence: number;
}

// Strategy is either the legacy manual chain ('priority'), one of the bandit
// presets, or 'custom' (a user-tuned weight vector persisted in settings — see
// router.ts). Each is just a weight vector — the engine is identical.
export type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom';

export const BANDIT_PRESETS: Record<Exclude<RoutingStrategy, 'priority' | 'custom'>, RoutingWeights> = {
  // Reliability leads; speed and intelligence split the rest evenly.
  balanced: { reliability: 0.5, speed: 0.25, intelligence: 0.25 },
  // Intelligence leads, but reliability still carries real weight so a smart
  // model that keeps failing doesn't win.
  smartest: { reliability: 0.35, speed: 0.1, intelligence: 0.55 },
  // Speed leads; reliability keeps a fast-but-broken model from winning.
  fastest: { reliability: 0.35, speed: 0.55, intelligence: 0.1 },
  // Reliability dominates — for clients that just want it to work.
  reliable: { reliability: 0.7, speed: 0.15, intelligence: 0.15 },
};

// Analytics-driven routing is on by default ('balanced'). Operators who want the
// old hand-ordered chain can switch the strategy to 'priority' from the
// dashboard or PUT /api/fallback/routing.
export const DEFAULT_STRATEGY: RoutingStrategy = 'balanced';

// ── Reliability ───────────────────────────────────────────────────────────
// Beta(1,1) prior = uniform: an unseen model is genuinely uncertain, not assumed
// good or bad. With decay-weighted pseudo-counts the alpha/beta are continuous.
export const PRIOR_SUCCESS = 1;
export const PRIOR_FAILURE = 1;

export function reliabilityPosterior(successes: number, failures: number): { alpha: number; beta: number } {
  return {
    alpha: Math.max(0, successes) + PRIOR_SUCCESS,
    beta: Math.max(0, failures) + PRIOR_FAILURE,
  };
}

// Deterministic expected reliability — used for the dashboard display score.
export function expectedReliability(successes: number, failures: number): number {
  const { alpha, beta } = reliabilityPosterior(successes, failures);
  return alpha / (alpha + beta);
}

// ── Speed (throughput + TTFB blended into one [0,1] axis) ───────────────────
// Throughput uses a saturating curve so one very fast tiny model can't make a
// perfectly-fine larger model look "slow" (the global-max-normalization bug in
// the fork). TTFB is a simple linear ramp from "instant" to "painfully slow".
export const SPEED_SCALE_TOK_S = 60;   // tok/s at which throughput ≈ 0.63
export const TTFB_BEST_MS = 300;       // ≤ this → full latency credit
export const TTFB_WORST_MS = 5000;     // ≥ this → zero latency credit
const THROUGHPUT_WEIGHT = 0.6;         // within the speed axis
const TTFB_WEIGHT = 0.4;
// Optimistic prior so unmeasured models still get explored on the speed axis.
export const SPEED_PRIOR = 0.6;

function throughputScore(tokPerSec: number): number {
  if (tokPerSec <= 0) return 0;
  return 1 - Math.exp(-tokPerSec / SPEED_SCALE_TOK_S);
}

function ttfbScore(ttfbMs: number): number {
  if (ttfbMs <= TTFB_BEST_MS) return 1;
  if (ttfbMs >= TTFB_WORST_MS) return 0;
  return 1 - (ttfbMs - TTFB_BEST_MS) / (TTFB_WORST_MS - TTFB_BEST_MS);
}

/**
 * Blend throughput and TTFB into a single [0,1] speed score.
 * `tokPerSec <= 0` means no successful samples → return the exploration prior.
 * `ttfbMs === null` means we have throughput but no first-byte timing → fall
 * back to throughput alone rather than guessing latency.
 */
export function speedScore(tokPerSec: number, ttfbMs: number | null): number {
  if (tokPerSec <= 0 && ttfbMs === null) return SPEED_PRIOR;
  const tp = throughputScore(tokPerSec);
  if (ttfbMs === null) return tp;
  if (tokPerSec <= 0) return ttfbScore(ttfbMs);
  return THROUGHPUT_WEIGHT * tp + TTFB_WEIGHT * ttfbScore(ttfbMs);
}

// ── Heavy-weighted real performance scoring ─────────────────────────────────
// When real performance data exists, weight it very heavily (90-95%) over the
// default speed score. When no data, fall back to pure default weighting.
// This implements the user's request: heavily sort by real token/sec.

// Threshold: below this many total requests, we don't trust the real data enough
// to dominate the score. Gradually transition as confidence grows.
export const REAL_SPEED_CONFIDENCE_THRESHOLD = 50; // requests needed for full confidence

// Weight given to real performance data at full confidence (0.0 to 1.0)
export const REAL_SPEED_MAX_WEIGHT = 0.95; // heavily favor real data when confident

/**
 * Calculate confidence factor based on total request count.
 * Returns 0.0 (no confidence) when no data, scales up to 1.0 at threshold.
 * Uses a smooth logistic curve for gradual transition.
 */
function realDataConfidence(totalRequests: number): number {
  if (totalRequests <= 0) return 0;
  // Logistic curve: approaches 1.0 as totalRequests >> threshold
  // At threshold/2 → ~0.5, at threshold → ~0.73, at 2*threshold → ~0.88
  return 1 / (1 + Math.exp(-(totalRequests - REAL_SPEED_CONFIDENCE_THRESHOLD) / (REAL_SPEED_CONFIDENCE_THRESHOLD / 3)));
}

/**
 * Heavy-weighted speed score that favors real performance data.
 *
 * When no performance data exists: uses default speed_score only (pure prior).
 * When little data exists: blends default score with real data based on confidence.
 * When lots of data exists: heavily weights real token/sec (up to 95%).
 *
 * @param tokPerSec - Measured real tokens per second from actual requests
 * @param ttfbMs - Measured time to first byte from actual requests
 * @param totalRequests - Total number of requests for confidence calculation
 * @param defaultSpeedScore - Default score from manual/prior settings (0-1)
 */
export function heavyWeightedSpeedScore(
  tokPerSec: number,
  ttfbMs: number | null,
  totalRequests: number,
  defaultSpeedScore: number
): number {
  // Calculate how much we trust the real data
  const confidence = realDataConfidence(totalRequests);

  // If no real data at all, use pure default
  if (tokPerSec <= 0 && totalRequests <= 0) {
    return defaultSpeedScore;
  }

  // Calculate real performance score from actual data
  const realScore = speedScore(tokPerSec, ttfbMs);

  // Blend weight: 0% real data when no confidence, up to max weight when fully confident
  const realWeight = confidence * REAL_SPEED_MAX_WEIGHT;
  const defaultWeight = 1 - realWeight;

  // Weighted blend of real performance and default score
  return (realWeight * realScore) + (defaultWeight * defaultSpeedScore);
}

// ── Intelligence ────────────────────────────────────────────────────────────
// Caller supplies a composite value from intelligenceComposite() and
// the min/max across the enabled chain. We min-max normalize to [0,1], 1 = best.
export function intelligenceScore(composite: number, min: number, max: number): number {
  if (max <= min) return 1; // single model or all equal → neutral-high
  return (composite - min) / (max - min);
}

// ── Speed composite (manual speed_rank + size tier penalty) ────────────────
// Mirrors the intelligenceComposite pattern: generates a composite value from
// speed_rank and size_label for min-max normalization. Lower rank = faster.
// Larger models get a tier penalty so a fast tiny model doesn't make a large
// model look "slow" in relative terms — they're normalized within their class.
export function speedCompositeFromRank(speedRank: number, sizeLabel: string): number {
  const TIER_PENALTY: Record<string, number> = {
    Small: 0,
    Medium: 100,
    Large: 200,
    Frontier: 300,
    Custom: 150,
  };
  const penalty = TIER_PENALTY[sizeLabel] ?? 150;
  // Invert rank so lower rank (faster) → higher composite value
  return 1000 - speedRank + penalty;
}

// ── Guardrail: free-quota headroom ──────────────────────────────────────────
// Multiplier that stays at 1 while a model has comfortable monthly headroom and
// ramps down to a floor as it approaches its free-tier cap, so we stop steering
// traffic at a model we're about to burn out. Unknown budget (0) → no opinion.
export const HEADROOM_FLOOR = 0.1;
export const HEADROOM_RAMP_START = 0.2; // start protecting at 20% remaining

export function headroomFactor(usedTokens: number, budgetTokens: number): number {
  if (!budgetTokens || budgetTokens <= 0) return 1; // unknown budget → no opinion
  const remaining = Math.max(0, 1 - usedTokens / budgetTokens);
  if (remaining >= HEADROOM_RAMP_START) return 1;
  // Linear from (0 remaining → floor) to (RAMP_START remaining → 1).
  return HEADROOM_FLOOR + (1 - HEADROOM_FLOOR) * (remaining / HEADROOM_RAMP_START);
}

// ── Guardrail: live rate-limit penalty ──────────────────────────────────────
// Maps the existing 0..MAX_PENALTY 429 penalty to a multiplier. At max penalty a
// model keeps 40% of its score — demoted hard but never fully excluded, so it
// can recover once the penalty decays.
export const MAX_PENALTY = 10;
export const RATE_LIMIT_MAX_DAMP = 0.6;

export function rateLimitFactor(penalty: number): number {
  const p = Math.min(Math.max(0, penalty), MAX_PENALTY);
  return 1 - (p / MAX_PENALTY) * RATE_LIMIT_MAX_DAMP;
}

// ── Beta sampler (Marsaglia & Tsang via two Gamma draws) ────────────────────
function randomNormal(): number {
  const u1 = Math.random() || Number.EPSILON;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}

function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random() || Number.EPSILON, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (; ;) {
    let x: number, v: number;
    do { x = randomNormal(); v = 1 + c * x; } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  const sum = x + y;
  return sum > 0 ? x / sum : 0.5;
}

// ── The combined score ──────────────────────────────────────────────────────
export interface ScoreInputs {
  reliability: number;   // [0,1] — sampled (routing) or expected (display)
  speed: number;         // [0,1]
  intelligence: number;  // [0,1]
  headroom: number;      // [floor,1] multiplier
  rateLimit: number;     // [floor,1] multiplier
}

/**
 * Convex base (∈[0,1]) × the two guardrail multipliers. The weights are assumed
 * to sum to 1; if a caller passes a non-normalized vector we renormalize so the
 * base never escapes [0,1].
 */
export function combineScore(inputs: ScoreInputs, weights: RoutingWeights): number {
  const wSum = weights.reliability + weights.speed + weights.intelligence || 1;
  const base =
    (weights.reliability * inputs.reliability +
      weights.speed * inputs.speed +
      weights.intelligence * inputs.intelligence) / wSum;
  return base * inputs.headroom * inputs.rateLimit;
}
