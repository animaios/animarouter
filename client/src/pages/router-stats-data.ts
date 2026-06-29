import type { ModelStats, ModelTimelineResponse } from "../../../shared/types";

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

  const otherRequests = hiddenModels.reduce((sum, row) => sum + row.requests, 0);
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
