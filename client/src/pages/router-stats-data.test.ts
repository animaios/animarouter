import { describe, expect, it } from "vitest";
import type { ModelStats } from "../../../shared/types";
import { buildModelMixData } from "./router-stats-data";

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
});
