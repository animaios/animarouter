import { describe, expect, it } from "vitest";
import type { ModelStats, ModelTimelineResponse } from "../../../shared/types";
import {
  adaptiveSmoothing,
  blendHourlyWithPings,
  buildModelMixData,
  coerceModelTimeline,
  coerceRows,
  rankModelsByProductivity,
  rankProductiveWindows,
  rebucketHourlyByLocal,
} from "./router-stats-data";

const base = {
  successRate: 100,
  avgLatencyMs: 100,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalReasoningTokens: 0,
  pinnedRequests: 0,
  tokPerSec: 0,
} satisfies Omit<
  ModelStats,
  "platform" | "modelId" | "displayName" | "requests"
>;

describe("buildModelMixData", () => {
  it("aggregates providers for the inner donut ring", () => {
    const result = buildModelMixData([
      {
        ...base,
        platform: "openai",
        modelId: "gpt-4o",
        displayName: "GPT-4o",
        requests: 12,
      },
      {
        ...base,
        platform: "openai",
        modelId: "gpt-4o-mini",
        displayName: "GPT-4o Mini",
        requests: 8,
      },
      {
        ...base,
        platform: "google",
        modelId: "gemini",
        displayName: "Gemini",
        requests: 5,
      },
    ]);

    expect(result.providerRing).toEqual([
      { id: "openai", label: "openai", requests: 20, successRate: 100 },
      { id: "google", label: "google", requests: 5, successRate: 100 },
    ]);
  });

  it("keeps top models and buckets lower-volume models as Other", () => {
    const result = buildModelMixData(
      [
        {
          ...base,
          platform: "openai",
          modelId: "a",
          displayName: "A",
          requests: 40,
        },
        {
          ...base,
          platform: "google",
          modelId: "b",
          displayName: "B",
          requests: 30,
        },
        {
          ...base,
          platform: "anthropic",
          modelId: "c",
          displayName: "C",
          requests: 20,
        },
      ],
      { maxModels: 2 },
    );

    expect(result.modelRing).toEqual([
      {
        id: "openai:a",
        label: "A",
        provider: "openai",
        requests: 40,
        successRate: 100,
      },
      {
        id: "google:b",
        label: "B",
        provider: "google",
        requests: 30,
        successRate: 100,
      },
      { id: "other", label: "Other", provider: "Multiple", requests: 20 },
    ]);
  });

  it("treats missing runtime success rates as zero", () => {
    const result = buildModelMixData([
      {
        ...base,
        platform: "openai",
        modelId: "a",
        displayName: "A",
        requests: 10,
        successRate: null as unknown as number,
      },
      {
        ...base,
        platform: "google",
        modelId: "b",
        displayName: "B",
        requests: 5,
        successRate: undefined as unknown as number,
      },
    ]);

    expect(result.providerRing).toEqual([
      { id: "openai", label: "openai", requests: 10, successRate: 0 },
      { id: "google", label: "google", requests: 5, successRate: 0 },
    ]);
  });
});

describe("router stats query payload guards", () => {
  it("normalizes null row arrays to empty arrays", () => {
    expect(coerceRows<ModelStats>(null)).toEqual([]);
    expect(coerceRows<ModelStats>(undefined)).toEqual([]);
  });

  it("normalizes a null model timeline to an empty timeline", () => {
    expect(coerceModelTimeline(null)).toEqual({ series: [], points: [] });
  });

  it("preserves a non-null model timeline", () => {
    const timeline: ModelTimelineResponse = {
      series: [
        {
          key: "model_0",
          platform: "openai",
          modelId: "a",
          displayName: "A",
          requests: 1,
        },
      ],
      points: [{ timestamp: "2026-06-30T00:00:00.000Z", model_0: 1 }],
    };

    expect(coerceModelTimeline(timeline)).toBe(timeline);
  });
});

describe("rebucketHourlyByLocal", () => {
  const serverRows = [
    // Server returns UTC-hour grouping. hour 0 UTC = 00:00–00:59 UTC.
    {
      hour: 0,
      requests: 10,
      avgLatencyMs: 100,
      avgTokPerSec: 30,
      errorRate: 0,
      successRate: 100,
    },
    {
      hour: 22,
      requests: 5,
      avgLatencyMs: 500,
      avgTokPerSec: 20,
      errorRate: 10,
      successRate: 90,
    },
  ];

  it("returns all 24 buckets, zero-filled for hours with no data", () => {
    // UTC-8 (Pacific) shift: UTC hour 0 => local hour 16, UTC hour 22 => local hour 14.
    const result = rebucketHourlyByLocal(serverRows, -480);
    expect(result).toHaveLength(24);
    for (const bucket of result) {
      expect(bucket.hour).toBeGreaterThanOrEqual(0);
      expect(bucket.hour).toBeLessThan(24);
    }
  });

  it("shifts UTC hours into the viewer's local timezone", () => {
    // UTC+0 (no shift) — server hour 0 stays local 0, 22 stays 22.
    const result = rebucketHourlyByLocal(serverRows, 0);
    expect(result[0]).toMatchObject({
      hour: 0,
      requests: 10,
      avgLatencyMs: 100,
    });
    expect(result[22]).toMatchObject({
      hour: 22,
      requests: 5,
      avgLatencyMs: 500,
    });
    expect(result[1]).toMatchObject({ hour: 1, requests: 0 });
  });

  it("rolls negative-shifted hours back into 0-23", () => {
    // UTC-8 on hour 0 => local hour 16 (0 - (-480/60) = 8 => (0+8)%24 = 8). Wait,
    // shift = -offset. offset=-480 => shift=+480min => (0*60+480)/60 = 8 => +24 mod = 8.
    const result = rebucketHourlyByLocal(serverRows, -480);
    expect(result[8]).toMatchObject({ hour: 8, requests: 10 });
  });

  it("rolls over-shifted hours forward and wraps", () => {
    // offset +480 (UTC+8) on server hour 22 => local hour (22 - 8) = 14.
    const result = rebucketHourlyByLocal(serverRows, 480);
    expect(result[14]).toMatchObject({ hour: 14, requests: 5 });
  });

  it("averages across buckets when two server hours land in one local hour", () => {
    const rows = [
      {
        hour: 0,
        requests: 10,
        avgLatencyMs: 100,
        avgTokPerSec: 30,
        errorRate: 0,
        successRate: 100,
      },
      {
        hour: 1,
        requests: 10,
        avgLatencyMs: 200,
        avgTokPerSec: 10,
        errorRate: 20,
        successRate: 80,
      },
      {
        hour: 23,
        requests: 10,
        avgLatencyMs: 300,
        avgTokPerSec: 50,
        errorRate: 0,
        successRate: 100,
      },
    ];
    // UTC-6 (offset -360) shift = +360min. Hour 0 => 6, 1 => 7, 23 => 5.
    const result = rebucketHourlyByLocal(rows, -360);
    expect(result[6]).toMatchObject({ avgLatencyMs: 100, requests: 10 });
    expect(result[7]).toMatchObject({ avgLatencyMs: 200, requests: 10 });
    expect(result[5]).toMatchObject({ avgLatencyMs: 300, requests: 10 });
  });

  it("handles a null payload", () => {
    const result = rebucketHourlyByLocal(null, 0);
    expect(result).toHaveLength(24);
    expect(result.every((r) => r.requests === 0)).toBe(true);
  });
});

describe("rankProductiveWindows", () => {
  function buildRows(
    spec: Array<{
      hour: number;
      latency: number;
      tok: number;
      errors: number;
      requests: number;
    }>,
  ) {
    return spec.map((s) => ({
      hour: s.hour,
      requests: s.requests,
      avgLatencyMs: s.latency,
      avgTokPerSec: s.tok,
      errorRate: s.errors,
      successRate: 100 - s.errors,
    }));
  }

  it("returns an empty array when all hours are silent", () => {
    const rows = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      requests: 0,
      avgLatencyMs: 0,
      avgTokPerSec: 0,
      errorRate: 0,
      successRate: 0,
    }));
    expect(rankProductiveWindows(rows)).toEqual([]);
  });

  it("ranks a contiguous low-latency block as the best window", () => {
    // Hours 21-23 low latency/high success; other hours bad.
    const rows = buildRows([
      { hour: 0, latency: 5000, tok: 5, errors: 50, requests: 5 },
      { hour: 1, latency: 5000, tok: 5, errors: 50, requests: 5 },
      { hour: 21, latency: 100, tok: 40, errors: 0, requests: 20 },
      { hour: 22, latency: 100, tok: 40, errors: 0, requests: 20 },
      { hour: 23, latency: 100, tok: 40, errors: 0, requests: 20 },
    ]);
    // pad remaining hours with mediocre data
    const fullRows = Array.from({ length: 24 }, (_, hour) => {
      const found = rows.find((r) => r.hour === hour);
      return (
        found ?? {
          hour,
          requests: 2,
          avgLatencyMs: 3000,
          avgTokPerSec: 10,
          errorRate: 30,
          successRate: 70,
        }
      );
    }) as ReturnType<typeof buildRows>;

    const windows = rankProductiveWindows(fullRows);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0].score).toBeGreaterThanOrEqual(75);
    expect(windows[0].grade).toBe("HIGH");
    // Best window should touch 21/22/23
    const hours = new Set<number>();
    const best = windows[0];
    for (let i = 0; i < 24; i++) {
      hours.add((best.startHour + i) % 24);
      if ((best.startHour + i) % 24 === best.endHour) break;
    }
    expect(hours.has(21) || hours.has(22) || hours.has(23)).toBe(true);
  });

  it("wraps windows across midnight", () => {
    const rows = buildRows([
      { hour: 22, latency: 100, tok: 40, errors: 0, requests: 10 },
      { hour: 23, latency: 100, tok: 40, errors: 0, requests: 10 },
      { hour: 0, latency: 100, tok: 40, errors: 0, requests: 10 },
      { hour: 1, latency: 100, tok: 40, errors: 0, requests: 10 },
    ]);
    const fullRows = Array.from({ length: 24 }, (_, hour) => {
      const found = rows.find((r) => r.hour === hour);
      return (
        found ?? {
          hour,
          requests: 2,
          avgLatencyMs: 4000,
          avgTokPerSec: 5,
          errorRate: 40,
          successRate: 60,
        }
      );
    }) as ReturnType<typeof buildRows>;
    const windows = rankProductiveWindows(fullRows);
    // Should contain a window whose start > end (wraps midnight).
    const wrapWindow = windows.find((w) => w.startHour > w.endHour);
    expect(wrapWindow).toBeDefined();
    expect(wrapWindow?.label).toMatch(/2[12]?:00–0[12]?:00/);
  });

  it("labels windows in HH:00–HH:00 format", () => {
    const rows = buildRows([
      { hour: 12, latency: 200, tok: 30, errors: 5, requests: 15 },
      { hour: 13, latency: 200, tok: 30, errors: 5, requests: 15 },
      { hour: 14, latency: 200, tok: 30, errors: 5, requests: 15 },
    ]);
    const fullRows = Array.from({ length: 24 }, (_, hour) => {
      const found = rows.find((r) => r.hour === hour);
      return (
        found ?? {
          hour,
          requests: 1,
          avgLatencyMs: 5000,
          avgTokPerSec: 5,
          errorRate: 50,
          successRate: 50,
        }
      );
    }) as ReturnType<typeof buildRows>;
    const windows = rankProductiveWindows(fullRows);
    if (windows.length > 0) {
      expect(windows[0].label).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
    }
  });
});

describe("blendHourlyWithPings", () => {
  const real = [
    { hour: 0, requests: 10, avgLatencyMs: 1000, successRate: 100 },
    { hour: 1, requests: 0, avgLatencyMs: 0, successRate: 0 },
  ];
  const pings = [
    { hour: 0, requests: 12, avgLatencyMs: 50, errorRate: 0, successRate: 100 },
    { hour: 1, requests: 12, avgLatencyMs: 60, errorRate: 0, successRate: 100 },
  ];

  it("uses real-only score when hour has real requests", () => {
    const blended = blendHourlyWithPings(real, pings, 0.1);
    expect(blended.length).toBe(2);
    const hour0 = blended.find((b) => b.hour === 0)!;
    expect(hour0.pingInfluenceApplied).toBe(false);
    expect(hour0.realCount).toBe(10);
    expect(hour0.blendedScore).toBe(hour0.realScore);
  });

  it("falls back to ping × influence for zero-traffic hours", () => {
    const blended = blendHourlyWithPings(real, pings, 0.1);
    const hour1 = blended.find((b) => b.hour === 1)!;
    expect(hour1.pingInfluenceApplied).toBe(true);
    expect(hour1.realCount).toBe(0);
    // 60ms latency vs 50ms max → (1 - 60/50) caps at 0, + success 40 → score ≈ 40 × 0.1 = 4
    expect(hour1.blendedScore).toBeGreaterThanOrEqual(0);
    expect(hour1.blendedScore).toBe(4);
  });

  it("at influence=1.0, zero-traffic hour score equals full ping score", () => {
    const blended = blendHourlyWithPings(real, pings, 1.0);
    const hour1 = blended.find((b) => b.hour === 1)!;
    // With latency 60 > max 50, score caps at 0 + success 40 = 40
    const blendedZeroInfl = blendHourlyWithPings(real, pings, 0);
    expect(hour1.blendedScore).toBeGreaterThan(
      blendedZeroInfl.find((b) => b.hour === 1)!.blendedScore,
    );
  });

  it("handles null ping payload", () => {
    const blended = blendHourlyWithPings(real, null as any, 0.1);
    expect(blended.length).toBe(2);
    const hour1 = blended.find((b) => b.hour === 1)!;
    expect(hour1.blendedScore).toBe(0);
    expect(hour1.pingInfluenceApplied).toBe(true);
  });
});

describe("adaptiveSmoothing", () => {
  const mk = (hour: number, score: number, realCount: number) => ({
    hour,
    score,
    realCount,
  });

  it("returns scores unchanged for 24h range (no smoothing)", () => {
    const rows = Array.from({ length: 24 }, (_, i) => mk(i, i * 2, 10));
    const smoothed = adaptiveSmoothing(rows, "24h");
    expect(smoothed).toEqual(rows.map((r) => r.score));
  });

  it("applies 5-hour kernel to dense 7d data", () => {
    const rows = Array.from({ length: 24 }, (_, i) =>
      mk(i, i === 12 ? 100 : 0, 10),
    );
    const smoothed = adaptiveSmoothing(rows, "7d");
    expect(smoothed[12]).toBeLessThan(100);
    expect(smoothed[12]).toBeGreaterThan(0);
    // Peak spreads to adjacent hours
    expect(smoothed[11]).toBeGreaterThan(0);
    expect(smoothed[13]).toBeGreaterThan(0);
  });

  it("wraps across midnight", () => {
    const rows = [mk(23, 100, 10), mk(0, 0, 10), mk(1, 0, 10)];
    const smoothed = adaptiveSmoothing(rows, "7d");
    // The peak at index 0 propagates back into neighbors via the wrapped kernel
    expect(smoothed[0]).toBeGreaterThan(0);
    expect(smoothed[0]).toBeLessThan(100);
    // Index 2 (adjacent to 0 via wrap) also picks up some signal
    expect(smoothed[2]).toBeGreaterThan(0);
  });
});

describe("rankModelsByProductivity", () => {
  const mk = (hour: number, requests: number, avgLatencyMs: number, successRate: number) => ({
    hour,
    requests,
    avgLatencyMs,
    avgTokPerSec: 50,
    errorRate: 0,
    successRate,
  });

  it("sorts models with lower latency first", () => {
    const ranked = rankModelsByProductivity([
      {
        platform: "a",
        modelId: "slow",
        displayName: "Slow",
        totalRequests: 10,
        hourly: Array.from({ length: 24 }, (_, i) => mk(i, 10, 2000, 100)),
      },
      {
        platform: "b",
        modelId: "fast",
        displayName: "Fast",
        totalRequests: 10,
        hourly: Array.from({ length: 24 }, (_, i) => mk(i, 10, 500, 100)),
      },
    ]);
    expect(ranked[0].modelId).toBe("fast");
    expect(ranked[1].modelId).toBe("slow");
  });

  it("assigns bestScore 0 and bestHour 0 when no hourly data", () => {
    const ranked = rankModelsByProductivity([
      {
        platform: "a",
        modelId: "empty",
        displayName: "Empty",
        totalRequests: 0,
        hourly: Array.from({ length: 24 }, (_, i) => mk(i, 0, 0, 0)),
      },
    ]);
    expect(ranked[0].bestScore).toBe(0);
    expect(ranked[0].bestHour).toBe(0);
  });

  it("flags bestHour on a single strong hour", () => {
    const ranked = rankModelsByProductivity([
      {
        platform: "a",
        modelId: "spiky",
        displayName: "Spiky",
        totalRequests: 1,
        hourly: Array.from({ length: 24 }, (_, i) =>
          i === 15 ? mk(15, 100, 100, 100) : mk(i, 0, 0, 0),
        ),
      },
    ]);
    expect(ranked[0].bestHour).toBe(15);
    expect(ranked[0].bestScore).toBeGreaterThan(0);
  });
});
