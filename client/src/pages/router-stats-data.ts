import type {
  HourlyStat,
  ModelStats,
  ModelTimelineResponse,
  PingHourlyStat,
} from "../../../shared/types";

export type { PingHourlyStat };

export interface ProviderMixSlice {
  id: string;
  label: string;
  requests: number;
  successRate: number;
}

export interface ModelMixSlice {
  id: string;
  label: string;
  provider: string;
  requests: number;
  successRate?: number;
}

export interface ModelMixData {
  providerRing: ProviderMixSlice[];
  modelRing: ModelMixSlice[];
}

interface ModelMixOptions {
  maxModels?: number;
}

interface ProviderAccumulator {
  label: string;
  requests: number;
  successfulRequests: number;
}

const EMPTY_MODEL_TIMELINE: ModelTimelineResponse = { series: [], points: [] };

export function coerceRows<T>(rows: T[] | null | undefined): T[] {
  return rows ?? [];
}

export function coerceModelTimeline(
  modelTimeline: ModelTimelineResponse | null | undefined,
): ModelTimelineResponse {
  return modelTimeline ?? EMPTY_MODEL_TIMELINE;
}

function successCount(row: ModelStats) {
  return (row.requests * (row.successRate ?? 0)) / 100;
}

function weightedSuccessRate(successfulRequests: number, requests: number) {
  if (requests === 0) {
    return 0;
  }

  return Number(((successfulRequests / requests) * 100).toFixed(1));
}

export function buildModelMixData(
  rows: ModelStats[],
  options: ModelMixOptions = {},
): ModelMixData {
  const maxModels = options.maxModels ?? 10;
  const providerMap = new Map<string, ProviderAccumulator>();

  for (const row of rows) {
    const existing = providerMap.get(row.platform) ?? {
      label: row.platform,
      requests: 0,
      successfulRequests: 0,
    };
    existing.requests += row.requests;
    existing.successfulRequests += successCount(row);
    providerMap.set(row.platform, existing);
  }

  const providerRing = Array.from(providerMap.entries())
    .map(([id, provider]) => ({
      id,
      label: provider.label,
      requests: provider.requests,
      successRate: weightedSuccessRate(
        provider.successfulRequests,
        provider.requests,
      ),
    }))
    .sort((a, b) => b.requests - a.requests);

  const sortedModels = [...rows].sort((a, b) => b.requests - a.requests);
  const visibleModels = sortedModels.slice(0, maxModels);
  const hiddenModels = sortedModels.slice(maxModels);

  const modelRing: ModelMixSlice[] = visibleModels.map((row) => ({
    id: `${row.platform}:${row.modelId}`,
    label: row.displayName,
    provider: row.platform,
    requests: row.requests,
    successRate: row.successRate,
  }));

  const otherRequests = hiddenModels.reduce(
    (sum, row) => sum + row.requests,
    0,
  );
  if (otherRequests > 0) {
    modelRing.push({
      id: "other",
      label: "Other",
      provider: "Multiple",
      requests: otherRequests,
    });
  }

  return { providerRing, modelRing };
}

// The server groups by the UTC hour of each request (it has no view of the
// user's timezone). So hour 0 from the server might be 17:00–18:00 for a
// Pacific viewer. Re-bucket here using the local hour derived from each
// request's UTC timestamp so the "Best hours" chart matches the viewer's day.
export interface RebucketedHourlyStat {
  hour: number; // local hour 0-23
  requests: number;
  avgLatencyMs: number;
  avgTokPerSec: number;
  errorRate: number;
  successRate: number;
}

export function rebucketHourlyByLocal(
  rows: (HourlyStat | PingHourlyStat)[] | null | undefined,
  utcOffsetMinutes: number,
): RebucketedHourlyStat[] {
  const source = rows ?? [];
  const buckets = new Map<
    number,
    { requests: number; latencySum: number; tokSum: number; errorSum: number }
  >();

  const shiftMinutes = -utcOffsetMinutes;

  for (const row of source) {
    if (row.hour == null) continue;
    const localHour = ((row.hour * 60 + shiftMinutes) / 60 + 24) % 24;
    const localHourInt = Math.trunc(localHour);
    const existing = buckets.get(localHourInt) ?? {
      requests: 0,
      latencySum: 0,
      tokSum: 0,
      errorSum: 0,
    };
    existing.requests += row.requests;
    existing.latencySum += row.avgLatencyMs * row.requests;
    existing.errorSum += row.errorRate * row.requests;
    // Hour rows carry avgTokPerSec; ping rows don't — narrowing is automatic
    if ("avgTokPerSec" in row)
      existing.tokSum += row.avgTokPerSec * row.requests;
    buckets.set(localHourInt, existing);
  }

  const result: RebucketedHourlyStat[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const b = buckets.get(hour);
    if (!b || b.requests === 0) {
      result.push({
        hour,
        requests: 0,
        avgLatencyMs: 0,
        avgTokPerSec: 0,
        errorRate: 0,
        successRate: 0,
      });
      continue;
    }
    result.push({
      hour,
      requests: b.requests,
      avgLatencyMs: Math.round(b.latencySum / b.requests),
      avgTokPerSec: Number((b.tokSum / b.requests).toFixed(1)),
      errorRate: Math.round((b.errorSum / b.requests) * 10) / 10,
      successRate: Math.round((100 - b.errorSum / b.requests) * 10) / 10,
    });
  }

  return result;
}

// Rank the best work windows: contiguous spans of hours with low latency,
// high tok/s, and low error rate. Returns up to 5 windows sorted by score,
// where score combines normalized latency (lower better) and success rate
// (higher better).
export interface HourWindow {
  startHour: number;
  endHour: number; // inclusive
  label: string; // e.g. "21:00–01:00"
  score: number; // 0-100, higher = more productive
  grade: "HIGH" | "OK" | "LOW";
  avgLatencyMs: number;
  requests: number;
}

function hourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

function windowLabel(startHour: number, endHour: number): string {
  // Windows can wrap past midnight (e.g. 21:00–01:00).
  return `${hourLabel(startHour)}–${hourLabel((endHour + 1) % 24)}`;
}

export function rankProductiveWindows(
  rows: RebucketedHourlyStat[],
  options: { minRequests?: number } = {},
): HourWindow[] {
  const minRequests = options.minRequests ?? 0;
  const byHour = new Map<number, RebucketedHourlyStat>();
  for (const r of rows) byHour.set(r.hour, r);

  // Build a circadian-weighted score per hour. Combine inverses so low latency
  // and high success both raise the score, then normalize to 0-100.
  const maxLatency = Math.max(1, ...rows.map((r) => r.avgLatencyMs));

  const scoreOf = (r: RebucketedHourlyStat): number => {
    if (r.requests < minRequests) return 0;
    // Zero-traffic hours score 0 (no data => no excellence signal). This matters
    // only when minRequests is 0; with minRequests>0 we already catch it above.
    if (r.requests === 0) return 0;
    const latencyScore = (1 - r.avgLatencyMs / maxLatency) * 60;
    const successScore = (r.successRate / 100) * 30;
    const tokScore = Math.min(r.avgTokPerSec / 80, 1) * 10;
    return Math.round(latencyScore + successScore + tokScore);
  };

  const zeroRow: RebucketedHourlyStat = {
    hour: 0,
    requests: 0,
    avgLatencyMs: 0,
    avgTokPerSec: 0,
    errorRate: 0,
    successRate: 0,
  };
  const hourScores = new Map<number, number>();
  for (let hour = 0; hour < 24; hour++) {
    hourScores.set(hour, scoreOf(byHour.get(hour) ?? zeroRow));
  }

  // Average neighboring hours to smooth single-hour spikes, then find runs of
  // GOOD (>55) hours. Allow wrap across midnight.
  const smoothed = Array.from({ length: 48 }, (_, i) => {
    const h = i % 24;
    const prev = hourScores.get((h + 23) % 24) ?? 0;
    const next = hourScores.get((h + 1) % 24) ?? 0;
    return (prev + 2 * (hourScores.get(h) ?? 0) + next) / 4;
  });

  const GOOD_THRESHOLD = 55;
  const runs: Array<{ start: number; end: number; avg: number }> = [];
  let runStart = -1;
  let runSum = 0;
  let runLen = 0;

  for (let i = 0; i < 48; i++) {
    if (smoothed[i] >= GOOD_THRESHOLD) {
      if (runStart === -1) runStart = i;
      runSum += smoothed[i];
      runLen++;
    } else if (runStart !== -1) {
      if (runLen >= 2) {
        runs.push({
          start: runStart % 24,
          end: (i - 1) % 24,
          avg: runSum / runLen,
        });
      }
      runStart = -1;
      runSum = 0;
      runLen = 0;
    }
  }
  if (runStart !== -1 && runLen >= 2) {
    runs.push({ start: runStart % 24, end: 47 % 24, avg: runSum / runLen });
  }

  const wrapped = runs.some((r) => r.start > r.end);

  // Aggregate runs that touch or overlap, including the wrap-across pair.
  const windows: HourWindow[] = runs.map((run) => {
    const hours: number[] = [];
    for (let i = 0; i < 24; i++) {
      const candidate = (run.start + i) % 24;
      hours.push(candidate);
      if (candidate === run.end) break;
    }
    let totalRequests = 0;
    let latencySum = 0;
    let reqCount = 0;
    for (const h of hours) {
      const r = byHour.get(h) ?? zeroRow;
      totalRequests += r.requests;
      latencySum += r.avgLatencyMs * r.requests;
      reqCount += r.requests;
    }
    const score = Math.round(run.avg);
    return {
      startHour: run.start,
      endHour: run.end,
      label: windowLabel(run.start, run.end),
      score,
      grade:
        score >= 75
          ? ("HIGH" as const)
          : score >= 55
            ? ("OK" as const)
            : ("LOW" as const),
      avgLatencyMs: reqCount > 0 ? Math.round(latencySum / reqCount) : 0,
      requests: totalRequests,
    } satisfies HourWindow;
  });

  windows.sort((a, b) => b.score - a.score);

  // Dedupe against the wrapped-across pair: if start==end overlap and one is
  // the wrap half of the other, keep the higher-scored one. Dedup by label
  // since the halves are different object references.
  if (wrapped) {
    const seen = new Set<string>();
    return windows
      .filter((w) => {
        if (seen.has(w.label)) return false;
        seen.add(w.label);
        return true;
      })
      .slice(0, 5);
  }

  return windows.slice(0, 5);
}

// ── Production Influence ─────────────────────────────────────────────────
// Blends real-request score + ping score for a single hour. Real wins when
// there are real requests; pings fill the floor when there aren't, weighted
// by the influence factor so it never dominates the chart.
export interface BlendedHourScore {
  hour: number;
  blendedScore: number;
  realScore: number;
  pingInfluenceApplied: boolean; // true means we fell back to ping-only for this hour
  realCount: number;
  pingCount: number;
}

// Per-ping-blended score: latency (lower better) scaled against the
// range-wide ping max + success bonus. Pure signal → 0..100.
interface PingHourlyLike {
  hour: number;
  avgLatencyMs: number;
  successRate: number;
}

function scoreOfPingRange(
  rows: ReadonlyArray<PingHourlyLike> | null | undefined,
  hour: number,
): number {
  if (!rows || rows.length === 0) return 0;
  const maxLatency = Math.max(1, ...rows.map((r) => r.avgLatencyMs));
  const datum = rows.find((r) => r.hour === hour);
  if (!datum || datum.avgLatencyMs === 0) return 0;
  const latencyScore = (1 - datum.avgLatencyMs / maxLatency) * 60;
  const successScore = (datum.successRate / 100) * 40;
  return Math.max(0, Math.round(latencyScore + successScore));
}

export function blendHourlyWithPings(
  realRows: ReadonlyArray<{
    hour: number;
    requests: number;
    avgLatencyMs: number;
    successRate: number;
  }>,
  pingRows:
    | ReadonlyArray<{
        hour: number;
        requests: number;
        avgLatencyMs: number;
        successRate: number;
      }>
    | null
    | undefined,
  influence: number,
): BlendedHourScore[] {
  if (realRows.length === 0) return [];
  const safePingRows = pingRows ?? [];
  const maxRealLatency = Math.max(
    1,
    ...realRows.flatMap((r) => (r.requests > 0 ? [r.avgLatencyMs] : [])),
  );
  const clampInfluence = Math.max(0, Math.min(1, influence));

  return realRows.map((real) => {
    // Real-only score uses the same 60/40 weighting as ping score
    const realLatencyScore =
      real.requests > 0 ? (1 - real.avgLatencyMs / maxRealLatency) * 60 : 0;
    const realSuccessScore = (real.successRate / 100) * 40;
    const realScore =
      real.requests > 0
        ? Math.max(0, Math.round(realLatencyScore + realSuccessScore))
        : 0;

    // If no real requests this hour, blend in ping baseline scaled by influence.
    if (real.requests === 0) {
      const pingScore = scoreOfPingRange(safePingRows, real.hour);
      return {
        hour: real.hour,
        blendedScore: Math.round(pingScore * clampInfluence),
        realScore: 0,
        pingInfluenceApplied: true,
        realCount: 0,
        pingCount:
          safePingRows.find((p) => p.hour === real.hour)?.requests ?? 0,
      };
    }

    return {
      hour: real.hour,
      blendedScore: realScore,
      realScore,
      pingInfluenceApplied: false,
      realCount: real.requests,
      pingCount: safePingRows.find((p) => p.hour === real.hour)?.requests ?? 0,
    };
  });
}

// ── Adaptive Smoothing ────────────────────────────────────────────────────
// Default 5-hour weighted kernel (1,2,3,2,1)/9. Sparse-hour fallback (count<3)
// uses a wider 7-hour kernel (1,1,2,3,2,1,1)/11.

const KERNEL_5 = [1, 2, 3, 2, 1];
const KERNEL_5_SUM = KERNEL_5.reduce((a, b) => a + b, 0);
const KERNEL_7 = [1, 1, 2, 3, 2, 1, 1];
const KERNEL_7_SUM = KERNEL_7.reduce((a, b) => a + b, 0);
const SPARSE_THRESHOLD = 3;

export function adaptiveSmoothing(
  rows: ReadonlyArray<{ hour: number; score: number; realCount: number }>,
  range: "15m" | "1h" | "24h" | "7d" | "30d",
): number[] {
  if (range === "24h" || range === "15m" || range === "1h") {
    // Short ranges: no smoothing — hour-of-day is the signal.
    return rows.map((r) => r.score);
  }
  const n = rows.length;
  return rows.map((_, i) => {
    const kernel = rows[i].realCount < SPARSE_THRESHOLD ? KERNEL_7 : KERNEL_5;
    const sum = kernel === KERNEL_7 ? KERNEL_7_SUM : KERNEL_5_SUM;
    const half = Math.floor(kernel.length / 2);

    let total = 0;
    for (let k = -half; k <= half; k++) {
      const j = (((i + k) % n) + n) % n;
      total += rows[j].score * kernel[k + half];
    }
    return total / sum;
  });
}
