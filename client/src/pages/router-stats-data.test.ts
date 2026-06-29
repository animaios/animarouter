import { describe, expect, it } from "vitest";
import type { ModelStats, ModelTimelineResponse } from "../../../shared/types";
import {
  buildModelMixData,
  coerceModelTimeline,
  coerceRows,
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
