import type {
  AdviceResult,
  AdvisoryPayload,
  ChatMessage,
  RoutingAdvice,
} from "@animarouter/shared/types.js";
import { getDb, getSetting, setSetting } from "../db/index.js";
import { getAllStatesView, getBoost, setBoost } from "./degradation.js";
import { getFeatureSetting } from "./feature-settings.js";
import { collectOscillatorStats } from "./rabbit-shake.js";
import {
  getProviderDailyRequestCap,
  providerDailyRequestCount,
  setCooldown,
} from "./ratelimit.js";

const DEFAULT_ADVICE: RoutingAdvice = {
  confidence: 0,
  selfScore: 0,
  cooldownHint: 0,
  recheckSooner: false,
  oscillatorHint: "no_opinion",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AdvisorKeyHealth {
  penalty: number;
  healthy: boolean;
  lastError?: string;
  lastPingLatencyMs?: number;
}

export interface ApplyAdviceParams {
  advice: RoutingAdvice;
  modelDbId: number;
  platform: string;
  modelId: string;
  keyId: number;
  normalRecheckDelayMs?: number;
  scheduleRecheck?: (keyId: number, modelId: string, delayMs: number) => void;
}

interface RequestRow {
  platform: string;
  model_id: string;
  status: string;
  output_tokens: number;
  reasoning_tokens: number;
  latency_ms: number;
  ttfb_ms: number | null;
}

export function isAdvisorEnabled(): boolean {
  return getFeatureSetting("heartbeat_advisor_enabled") as boolean;
}

export function getAdvisorMaxInputTokens(): number {
  return getFeatureSetting("heartbeat_advisor_max_input_tokens") as number;
}

export function getAdvisorMaxOutputTokens(): number {
  return getFeatureSetting("heartbeat_advisor_max_output_tokens") as number;
}

export function buildAdvisoryPayload(params: {
  platform: string;
  modelDbId: number;
  modelId: string;
  keyId: number;
  keyHealth: ReadonlyMap<string, AdvisorKeyHealth>;
  now?: number;
}): AdvisoryPayload {
  const db = getDb();
  const now = params.now ?? Date.now();
  const windowMs =
    ((getFeatureSetting("scoring_window_days") as number) || 7) * DAY_MS;
  const since = new Date(now - windowMs).toISOString();

  const models = db
    .prepare(`
      SELECT m.id, m.platform, m.model_id
      FROM models m
      WHERE m.enabled = 1
        AND (
          m.platform = ?
          OR EXISTS (
            SELECT 1 FROM fallback_config fc
            WHERE fc.model_db_id = m.id AND fc.enabled = 1
          )
        )
      ORDER BY CASE WHEN m.platform = ? THEN 0 ELSE 1 END, m.intelligence_rank ASC
      LIMIT 16
    `)
    .all(params.platform, params.platform) as Array<{
    id: number;
    platform: string;
    model_id: string;
  }>;

  const cooldownRows = db
    .prepare(`
      SELECT key_id, model_id, expires_at_ms
      FROM rate_limit_cooldowns
      WHERE platform = ? AND expires_at_ms > ?
    `)
    .all(params.platform, now) as Array<{
    key_id: number;
    model_id: string;
    expires_at_ms: number;
  }>;

  const cooldownByKeyModel = new Map<
    string,
    { tier: number; remainingMs: number }
  >();
  for (const row of cooldownRows) {
    const remainingMs = Math.max(0, row.expires_at_ms - now);
    cooldownByKeyModel.set(`${row.key_id}:${row.model_id}`, {
      tier: cooldownTierFromRemaining(remainingMs),
      remainingMs,
    });
  }

  const keyRows = db
    .prepare(
      "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY id ASC",
    )
    .all(params.platform) as Array<{ id: number }>;

  const keys = keyRows.map((key) => ({
    keyId: key.id,
    models: models
      .filter((model) => model.platform === params.platform)
      .slice(0, 12)
      .map((model) => {
        const health = params.keyHealth.get(`${key.id}:${model.model_id}`);
        const cooldown = cooldownByKeyModel.get(`${key.id}:${model.model_id}`);
        return {
          model: model.model_id,
          healthy: health?.healthy ?? false,
          penalty: health?.penalty ?? 0,
          lastError: health?.lastError,
          lastPingLatencyMs: health?.lastPingLatencyMs,
          cooldownActive: !!cooldown,
          cooldownTier: cooldown?.tier,
        };
      }),
  }));

  const statsPlatforms =
    models.length > 0
      ? Array.from(new Set(models.map((model) => model.platform)))
      : [params.platform];
  const requestRows = db
    .prepare(`
      SELECT platform, model_id, status, output_tokens, reasoning_tokens, latency_ms, ttfb_ms
      FROM requests
      WHERE created_at >= ?
        AND request_type = 'chat'
        AND platform IN (${statsPlatforms.map(() => "?").join(",")})
    `)
    .all(since, ...statsPlatforms) as RequestRow[];

  const statsByModel = buildStatsByModel(requestRows);
  const degradationById = getAllStatesView();
  const modelSummaries = models.map((model) => {
    const stats = statsByModel.get(`${model.platform}:${model.model_id}`) ?? {
      successRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: undefined,
      tokPerSec: 0,
      avgTtfbMs: null,
    };
    const degradation = degradationById.get(model.id);
    return {
      model: model.model_id,
      provider: model.platform,
      stats,
      degradation: degradation
        ? {
            penalty: round(degradation.penalty, 2),
            tier: degradation.displayTier,
            consecutiveFailures: degradation.consecutiveHits,
            boost: round(degradation.boost, 2),
          }
        : undefined,
    };
  });

  const dailyCap = getProviderDailyRequestCap(params.platform);
  const dailyUsage = keyRows.map((key) => ({
    keyId: key.id,
    requestCount: providerDailyRequestCount(params.platform, key.id, now),
    dailyCap,
  }));

  const routing = {
    strategy: getSetting("routing_strategy") ?? "balanced",
    customWeights: parseCustomWeights(getSetting("routing_custom_weights")),
  };

  return sanitizePayload({
    self: { provider: params.platform, model: params.modelId },
    keys,
    models: modelSummaries,
    cooldowns: cooldownRows.map((row) => ({
      keyId: row.key_id,
      model: row.model_id,
      tier: cooldownTierFromRemaining(row.expires_at_ms - now),
      remainingMs: Math.max(0, row.expires_at_ms - now),
    })),
    dailyUsage,
    routing,
    oscillator: collectOscillatorStats(windowMs, now),
  });
}

export function sanitizePayload(payload: AdvisoryPayload): AdvisoryPayload {
  return {
    ...payload,
    keys: payload.keys.map((key) => ({
      keyId: key.keyId,
      models: key.models.map((model) => ({
        ...model,
        lastError: model.lastError
          ? categorizeError(model.lastError)
          : undefined,
      })),
    })),
    models: payload.models.map((model) => ({
      ...model,
      stats: {
        successRate: round(clamp(model.stats.successRate, 0, 1), 3),
        avgLatencyMs: Math.round(Math.max(0, model.stats.avgLatencyMs)),
        p95LatencyMs:
          model.stats.p95LatencyMs === undefined
            ? undefined
            : Math.round(Math.max(0, model.stats.p95LatencyMs)),
        tokPerSec: round(Math.max(0, model.stats.tokPerSec), 2),
        avgTtfbMs:
          model.stats.avgTtfbMs === null
            ? null
            : Math.round(Math.max(0, model.stats.avgTtfbMs)),
      },
    })),
    cooldowns: payload.cooldowns.map((cooldown) => ({
      keyId: cooldown.keyId,
      model: cooldown.model,
      tier: clampInt(cooldown.tier, 0, 4),
      remainingMs: Math.max(0, Math.round(cooldown.remainingMs)),
    })),
  };
}

export function truncateToTokenBudget(
  payload: AdvisoryPayload,
  maxTokens = getAdvisorMaxInputTokens(),
): AdvisoryPayload {
  const clone: AdvisoryPayload = JSON.parse(JSON.stringify(payload));
  const estimate = () => estimateTokens(JSON.stringify(clone));
  if (estimate() <= maxTokens) return clone;

  for (const key of clone.keys) key.models = key.models.slice(0, 3);
  if (estimate() <= maxTokens) return clone;

  clone.models = clone.models.slice(0, 8);
  if (estimate() <= maxTokens) return clone;

  clone.cooldowns = clone.cooldowns.slice(0, 8);
  clone.dailyUsage = clone.dailyUsage.slice(0, 8);
  if (estimate() <= maxTokens) return clone;

  for (const model of clone.models) delete model.degradation;
  if (estimate() <= maxTokens) return clone;

  clone.keys = clone.keys.slice(0, 4);
  clone.models = clone.models.slice(0, 4);
  if (estimate() <= maxTokens) return clone;

  clone.keys = [];
  clone.models = clone.models
    .filter(
      (model) =>
        model.provider === clone.self.provider &&
        model.model === clone.self.model,
    )
    .slice(0, 1);
  clone.cooldowns = [];
  clone.dailyUsage = [];
  if (estimate() <= maxTokens) return clone;

  clone.models = [];
  clone.oscillator = undefined;
  return clone;
}

export function buildAdvisoryMessages(
  payload: AdvisoryPayload,
  maxTokens = getAdvisorMaxInputTokens(),
): { messages: ChatMessage[]; estimatedInputTokens: number } {
  const compactPayload = truncateToTokenBudget(payload, maxTokens);
  const payloadJson = JSON.stringify(compactPayload);
  return {
    estimatedInputTokens: estimateTokens(payloadJson),
    messages: [
      {
        role: "system",
        content:
          'You are a routing advisor. Return compact JSON only: {"confidence":0-9,"selfScore":-9..9,"cooldownHint":0|1|2,"recheckSooner":boolean,"oscillatorHint":"enable|disable|no_opinion","injectionModel":"provider/model|provider:model|intelligence_rank:N","injectionBrevity":"shorter|longer|default"}. Use oscillatorHint only for Rabbit oscillator control, injectionModel only for a better divergent injection model, and injectionBrevity only when the two-sentence injection should change. No prose.',
      },
      {
        role: "user",
        content: payloadJson,
      },
    ],
  };
}

export function parseAdviceResponse(
  responseText: string | null | undefined,
): RoutingAdvice {
  const text = (responseText ?? "").trim();
  if (!text) return { ...DEFAULT_ADVICE };

  const json = parseJsonAdvice(text);
  if (json) return normalizeAdvice(json);

  const compact = parseCompactAdvice(text);
  if (compact) return normalizeAdvice(compact);

  return { ...DEFAULT_ADVICE };
}

export function applyAdvice(params: ApplyAdviceParams): AdviceResult[] {
  const advice = normalizeAdvice(params.advice);
  if (advice.confidence <= 0) {
    return [
      { applied: "no_opinion", modelDbId: params.modelDbId, magnitude: 0 },
    ];
  }

  const results: AdviceResult[] = [];

  if (advice.selfScore !== 0) {
    const magnitude =
      clamp(advice.selfScore / 9, -1, 1) * Math.min(2, advice.confidence / 4.5);
    const currentBoost = getBoost(params.modelDbId);
    const nextBoost = clamp(currentBoost + magnitude, 0.5, 2);
    setBoost(params.modelDbId, nextBoost);
    results.push({
      applied: advice.selfScore > 0 ? "score_boost" : "score_penalty",
      modelDbId: params.modelDbId,
      magnitude: round(nextBoost - currentBoost, 3),
    });
  }

  if (advice.cooldownHint === 1) {
    const durationMs = Math.round(
      (params.normalRecheckDelayMs ?? 90_000) * 1.5,
    );
    setCooldown(params.platform, params.modelId, params.keyId, durationMs);
    results.push({
      applied: "cooldown_extend",
      modelDbId: params.modelDbId,
      magnitude: durationMs,
    });
  } else if (advice.cooldownHint === 2) {
    const durationMs = Math.round(
      (params.normalRecheckDelayMs ?? 90_000) * 0.5,
    );
    setCooldown(params.platform, params.modelId, params.keyId, durationMs);
    results.push({
      applied: "cooldown_reduce",
      modelDbId: params.modelDbId,
      magnitude: durationMs,
    });
  }

  if (advice.recheckSooner && params.scheduleRecheck) {
    const delayMs = Math.round((params.normalRecheckDelayMs ?? 90_000) * 0.5);
    params.scheduleRecheck(params.keyId, params.modelId, delayMs);
    results.push({
      applied: "recheck_scheduled",
      modelDbId: params.modelDbId,
      magnitude: delayMs,
    });
  }

  if (advice.alt) {
    results.push({
      applied: "alt_suggested",
      modelDbId: params.modelDbId,
      magnitude: advice.confidence,
    });
  }

  if (advice.oscillatorHint === "enable") {
    const rabbitEnabled = getFeatureSetting("rabbit_enabled") as boolean;
    if (!rabbitEnabled && advice.confidence >= 7) {
      setSetting("rabbit_enabled", "true");
      results.push({
        applied: "oscillator_toggled",
        modelDbId: params.modelDbId,
        magnitude: 1,
      });
    }
  } else if (advice.oscillatorHint === "disable") {
    const rabbitEnabled = getFeatureSetting("rabbit_enabled") as boolean;
    if (rabbitEnabled && advice.confidence >= 4) {
      setSetting("rabbit_enabled", "false");
      results.push({
        applied: "oscillator_toggled",
        modelDbId: params.modelDbId,
        magnitude: -1,
      });
    }
  }

  if (advice.confidence >= 6) {
    const injectionModelDbId = advice.injectionModel
      ? resolveAdviceModelDbId(advice.injectionModel)
      : undefined;
    if (injectionModelDbId) {
      setSetting("oscillator_injection_selection", String(injectionModelDbId));
      results.push({
        applied: "injection_adjusted",
        modelDbId: injectionModelDbId,
        magnitude: injectionModelDbId,
      });
    }

    const injectionSentences = injectionBrevitySentenceLimit(
      advice.injectionBrevity,
    );
    if (injectionSentences != null) {
      setSetting(
        "oscillator_injection_max_sentences",
        String(injectionSentences),
      );
      results.push({
        applied: "injection_adjusted",
        modelDbId: params.modelDbId,
        magnitude: injectionSentences,
      });
    }
  }

  if (results.length === 0) {
    results.push({
      applied: "no_opinion",
      modelDbId: params.modelDbId,
      magnitude: 0,
    });
  }
  return results;
}

function resolveAdviceModelDbId(modelRef: string): number | undefined {
  const trimmed = modelRef.trim().slice(0, 80);
  if (!trimmed) return undefined;

  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric > 0) {
    return (
      getDb()
        .prepare("SELECT id FROM models WHERE enabled = 1 AND id = ?")
        .get(numeric) as { id: number } | undefined
    )?.id;
  }

  const rankMatch = trimmed.match(/^intelligence_rank\s*:\s*(\d+)$/i);
  if (rankMatch) {
    return (
      getDb()
        .prepare(
          "SELECT id FROM models WHERE enabled = 1 AND intelligence_rank = ? ORDER BY id ASC LIMIT 1",
        )
        .get(Number(rankMatch[1])) as { id: number } | undefined
    )?.id;
  }

  const providerModel = splitProviderModelRef(trimmed);
  if (!providerModel) return undefined;
  return (
    getDb()
      .prepare(
        "SELECT id FROM models WHERE enabled = 1 AND platform = ? AND model_id = ? ORDER BY id ASC LIMIT 1",
      )
      .get(providerModel.provider, providerModel.model) as
      | { id: number }
      | undefined
  )?.id;
}

function splitProviderModelRef(
  ref: string,
): { provider: string; model: string } | undefined {
  const colonIndex = ref.indexOf(":");
  if (colonIndex > 0) {
    const provider = ref.slice(0, colonIndex).trim();
    const model = ref.slice(colonIndex + 1).trim();
    if (!provider || !model) return undefined;
    return { provider, model };
  }

  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0) return undefined;
  const provider = ref.slice(0, slashIndex).trim();
  const model = ref.slice(slashIndex + 1).trim();
  if (!provider || !model) return undefined;
  return { provider, model };
}

function injectionBrevitySentenceLimit(
  brevity: RoutingAdvice["injectionBrevity"],
): number | undefined {
  if (brevity === "shorter") return 1;
  if (brevity === "default") return 2;
  if (brevity === "longer") return 3;
  return undefined;
}

function buildStatsByModel(rows: RequestRow[]) {
  const buckets = new Map<
    string,
    {
      total: number;
      successes: number;
      successLatencySum: number;
      successLatencies: number[];
      outputTokens: number;
      ttfbSum: number;
      ttfbCount: number;
    }
  >();
  for (const row of rows) {
    const key = `${row.platform}:${row.model_id}`;
    const bucket = buckets.get(key) ?? {
      total: 0,
      successes: 0,
      successLatencySum: 0,
      successLatencies: [],
      outputTokens: 0,
      ttfbSum: 0,
      ttfbCount: 0,
    };
    bucket.total += 1;
    if (row.status === "success") {
      bucket.successes += 1;
      bucket.successLatencySum += row.latency_ms;
      bucket.successLatencies.push(row.latency_ms);
      bucket.outputTokens +=
        (row.output_tokens ?? 0) + (row.reasoning_tokens ?? 0);
      if (row.ttfb_ms !== null) {
        bucket.ttfbSum += row.ttfb_ms;
        bucket.ttfbCount += 1;
      }
    }
    buckets.set(key, bucket);
  }

  const result = new Map<string, AdvisoryPayload["models"][number]["stats"]>();
  for (const [key, bucket] of buckets) {
    bucket.successLatencies.sort((a, b) => a - b);
    const p95Index = Math.max(
      0,
      Math.ceil(bucket.successLatencies.length * 0.95) - 1,
    );
    const avgLatencyMs =
      bucket.successes > 0 ? bucket.successLatencySum / bucket.successes : 0;
    result.set(key, {
      successRate: bucket.total > 0 ? bucket.successes / bucket.total : 0,
      avgLatencyMs,
      p95LatencyMs:
        bucket.successLatencies.length > 0
          ? bucket.successLatencies[p95Index]
          : undefined,
      tokPerSec:
        bucket.successLatencySum > 0
          ? (bucket.outputTokens * 1000) / bucket.successLatencySum
          : 0,
      avgTtfbMs:
        bucket.ttfbCount > 0 ? bucket.ttfbSum / bucket.ttfbCount : null,
    });
  }
  return result;
}

function parseJsonAdvice(text: string): Partial<RoutingAdvice> | null {
  const candidates = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed as Partial<RoutingAdvice>;
      }
    } catch {
      // Try compact format below.
    }
  }
  return null;
}

function parseCompactAdvice(text: string): Partial<RoutingAdvice> | null {
  const out: Partial<RoutingAdvice> = {};
  const fields = text
    .replace(/[{},]/g, " ")
    .split(/\s+/)
    .map((field) => field.trim())
    .filter(Boolean);

  for (const field of fields) {
    const match = field.match(/^([a-zA-Z_]+)\s*[:=]\s*(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = cleanCompactAdviceValue(match[2]);
    if (["c", "conf", "confidence"].includes(key))
      out.confidence = Number(value);
    if (["self", "selfscore", "self_score"].includes(key))
      out.selfScore = Number(value);
    if (["cooldown", "cooldownhint", "cooldown_hint"].includes(key))
      out.cooldownHint = Number(value);
    if (["recheck", "rechecksooner", "recheck_sooner"].includes(key)) {
      out.recheckSooner = /^(1|true|yes)$/i.test(value);
    }
    if (key === "alt") out.alt = value.slice(0, 80);
    if (["o", "oscillator", "oscillatorhint", "oscillator_hint"].includes(key))
      out.oscillatorHint = parseCompactOscillatorHint(value);
    if (["i", "injection", "injectionmodel", "injection_model"].includes(key))
      out.injectionModel = value.slice(0, 80);
    if (["b", "brevity", "injectionbrevity", "injection_brevity"].includes(key))
      out.injectionBrevity = parseCompactInjectionBrevity(value);
  }

  return Object.keys(out).length > 0 ? out : null;
}

function parseCompactOscillatorHint(
  value: string,
): RoutingAdvice["oscillatorHint"] {
  const normalized = cleanCompactAdviceValue(value).toLowerCase();
  if (normalized === "e" || normalized === "enable" || normalized === "enabled")
    return "enable";
  if (
    normalized === "d" ||
    normalized === "disable" ||
    normalized === "disabled"
  )
    return "disable";
  return "no_opinion";
}

function parseCompactInjectionBrevity(
  value: string,
): RoutingAdvice["injectionBrevity"] {
  const normalized = cleanCompactAdviceValue(value).toLowerCase();
  if (normalized === "s" || normalized === "shorter" || normalized === "short")
    return "shorter";
  if (normalized === "l" || normalized === "longer" || normalized === "long")
    return "longer";
  if (normalized === "d" || normalized === "default") return "default";
  return undefined;
}

function cleanCompactAdviceValue(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === "'" || first === '"') && first === last) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.replace(/^['"]|['"]$/g, "").trim();
}

function normalizeAdvice(input: Partial<RoutingAdvice>): RoutingAdvice {
  const oscillatorHint =
    typeof input.oscillatorHint === "string"
      ? parseCompactOscillatorHint(input.oscillatorHint)
      : "no_opinion";
  const injectionBrevity =
    typeof input.injectionBrevity === "string"
      ? parseCompactInjectionBrevity(input.injectionBrevity)
      : undefined;

  return {
    confidence: clampInt(Number(input.confidence ?? 0), 0, 9),
    selfScore: clampInt(Number(input.selfScore ?? 0), -9, 9),
    alt: typeof input.alt === "string" ? input.alt.slice(0, 80) : undefined,
    cooldownHint: clampInt(Number(input.cooldownHint ?? 0), 0, 2),
    recheckSooner: input.recheckSooner === true,
    oscillatorHint,
    injectionModel:
      typeof input.injectionModel === "string"
        ? cleanCompactAdviceValue(input.injectionModel).slice(0, 80)
        : undefined,
    injectionBrevity,
  };
}

function categorizeError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("429") || lower.includes("rate limit"))
    return "rate_limit";
  if (lower.includes("402") || lower.includes("payment"))
    return "payment_required";
  if (lower.includes("401") || lower.includes("auth")) return "auth_error";
  if (lower.includes("403") || lower.includes("forbidden")) return "forbidden";
  if (lower.includes("404") || lower.includes("not found")) return "not_found";
  if (lower.includes("timeout") || lower.includes("abort")) return "timeout";
  if (/\b5\d\d\b/.test(lower) || lower.includes("server"))
    return "server_error";
  return "other";
}

function parseCustomWeights(
  raw: string | undefined,
): Record<string, number> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function cooldownTierFromRemaining(remainingMs: number): number {
  if (remainingMs >= DAY_MS * 0.75) return 4;
  if (remainingMs >= 45 * 60 * 1000) return 3;
  if (remainingMs >= 5 * 60 * 1000) return 2;
  if (remainingMs > 0) return 1;
  return 0;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
