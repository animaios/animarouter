import { getDb } from "../db/index.js";
import { getFeatureSetting } from "./feature-settings.js";
import { getRoutingScores, type RoutingScore } from "./router.js";
import {
  BANDIT_PRESETS,
  combineScore,
  type RoutingStrategy,
  type RoutingWeights,
} from "./scoring.js";

export type FoundationSelection = "auto" | "top_rank" | number;
export type InjectionSelection =
  | "divergent"
  | "top_rank"
  | "different_tier"
  | number;

export interface OscillatorConfig {
  enabled: boolean;
  foundationSelection: FoundationSelection;
  injectionSelection: InjectionSelection;
  rabbitWeights?: RoutingWeights;
  minIntelligenceGap: number;
  injectionMaxSentences: number;
  meowPatterns: string[];
  loadShedThreshold: number;
  stepTimeoutMs: number;
  fallbackMode: "foundation_only" | "injection_only";
}

export interface RabbitCandidate extends RoutingScore {
  intelligenceRank: number;
  sizeLabel: string;
  supportsVision: boolean;
  supportsTools: boolean;
  contextWindow: number | null;
  rabbitScore: number;
}

export interface RabbitEligibilityInput {
  strategy: RoutingStrategy;
  promptText?: string | null;
  pinnedModelDbId?: number | null;
  loadShedActive?: boolean;
  config?: OscillatorConfig;
}

export interface MeowDetectionResult {
  detected: boolean;
  reason?:
    | "custom_pattern"
    | "structural_tag"
    | "repeated_character"
    | "replacement_character"
    | "script_fragmentation";
  pattern?: string;
}

export const RABBIT_DEFAULT_WEIGHTS: RoutingWeights = BANDIT_PRESETS.smartest;

const DEFAULT_MEOW_PATTERNS = [
  "<\\|[^>]+\\|>",
  "\\[(?:INST|/INST|SYS|/SYS|SYSTEM|ASSISTANT|USER)\\]",
  "(.)\\1{24,}",
];

function normalizeWeights(weights: RoutingWeights): RoutingWeights | undefined {
  const values = [
    weights.reliability,
    weights.speed,
    weights.intelligence,
    weights.latency,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return undefined;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) return undefined;
  return {
    reliability: weights.reliability / sum,
    speed: weights.speed / sum,
    intelligence: weights.intelligence / sum,
    latency: weights.latency / sum,
  };
}

export function parseRabbitWeights(
  raw: string | undefined,
): RoutingWeights | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<RoutingWeights>;
    if (
      typeof parsed.reliability !== "number" ||
      typeof parsed.speed !== "number" ||
      typeof parsed.intelligence !== "number" ||
      typeof parsed.latency !== "number"
    ) {
      return undefined;
    }
    return normalizeWeights({
      reliability: parsed.reliability,
      speed: parsed.speed,
      intelligence: parsed.intelligence,
      latency: parsed.latency,
    });
  } catch {
    return undefined;
  }
}

function parseSelection<T extends string>(
  raw: boolean | number | string,
  allowed: readonly T[],
  fallback: T,
): T | number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  const text = String(raw).trim();
  const numeric = Number(text);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  return allowed.includes(text as T) ? (text as T) : fallback;
}

export function getRabbitWeights(): RoutingWeights {
  return (
    parseRabbitWeights(getFeatureSetting("rabbit_weights") as string) ??
    RABBIT_DEFAULT_WEIGHTS
  );
}

export function getOscillatorConfig(): OscillatorConfig {
  return {
    enabled: getFeatureSetting("rabbit_enabled") as boolean,
    foundationSelection: parseSelection(
      getFeatureSetting("oscillator_foundation_selection"),
      ["auto", "top_rank"] as const,
      "auto",
    ),
    injectionSelection: parseSelection(
      getFeatureSetting("oscillator_injection_selection"),
      ["divergent", "top_rank", "different_tier"] as const,
      "divergent",
    ),
    rabbitWeights: parseRabbitWeights(
      getFeatureSetting("rabbit_weights") as string,
    ),
    minIntelligenceGap: getFeatureSetting(
      "oscillator_min_intelligence_gap",
    ) as number,
    injectionMaxSentences: getFeatureSetting(
      "oscillator_injection_max_sentences",
    ) as number,
    meowPatterns: DEFAULT_MEOW_PATTERNS,
    loadShedThreshold: getFeatureSetting(
      "oscillator_load_shed_threshold",
    ) as number,
    stepTimeoutMs: getFeatureSetting("oscillator_step_timeout_ms") as number,
    fallbackMode: "foundation_only",
  };
}

export function isComplexReasoningPrompt(promptText?: string | null): boolean {
  const text = (promptText ?? "").trim();
  if (text.length >= 180) return true;
  return /\b(reason|analyze|debug|prove|derive|compare|tradeoff|architecture|plan|why)\b/i.test(
    text,
  );
}

export function isRabbitOscillatorEligible(
  input: RabbitEligibilityInput,
): boolean {
  const config = input.config ?? getOscillatorConfig();
  return (
    input.strategy === "rabbit" &&
    config.enabled &&
    !input.pinnedModelDbId &&
    !input.loadShedActive &&
    isComplexReasoningPrompt(input.promptText)
  );
}

function matchesCustomPattern(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, "iu").test(text);
  } catch {
    return false;
  }
}

function scriptOf(char: string): string | null {
  if (!/\p{Letter}/u.test(char)) return null;
  if (/\p{Script=Latin}/u.test(char)) return "Latin";
  if (/\p{Script=Cyrillic}/u.test(char)) return "Cyrillic";
  if (/\p{Script=Greek}/u.test(char)) return "Greek";
  if (/\p{Script=Arabic}/u.test(char)) return "Arabic";
  if (/\p{Script=Han}/u.test(char)) return "Han";
  if (/\p{Script=Hangul}/u.test(char)) return "Hangul";
  if (/\p{Script=Hiragana}/u.test(char)) return "Hiragana";
  if (/\p{Script=Katakana}/u.test(char)) return "Katakana";
  if (/\p{Script=Devanagari}/u.test(char)) return "Devanagari";
  return "Other";
}

function hasScriptFragmentation(text: string): boolean {
  const sample = text.length > 1000 ? text.slice(0, 1000) : text;
  let previous: string | null = null;
  let switches = 0;
  const counts = new Map<string, number>();

  for (const char of sample) {
    const script = scriptOf(char);
    if (!script) continue;
    counts.set(script, (counts.get(script) ?? 0) + 1);
    if (previous && previous !== script) switches++;
    previous = script;
  }

  const substantialScripts = [...counts.values()].filter((count) => count >= 3);
  return substantialScripts.length >= 4 && switches >= 10;
}

export function detectMeow(
  text: string,
  patterns: string[] = DEFAULT_MEOW_PATTERNS,
): MeowDetectionResult {
  const normalized = text.trim();
  if (normalized.length === 0) return { detected: false };

  if (
    /<\|[^>\n]{1,80}\|>|\[(?:INST|\/INST|SYS|\/SYS|SYSTEM|ASSISTANT|USER)\]|<\/?(?:system|assistant|user)>/iu.test(
      normalized,
    )
  ) {
    return { detected: true, reason: "structural_tag" };
  }

  if (/(.)\1{24,}/u.test(normalized)) {
    return { detected: true, reason: "repeated_character" };
  }

  if (/\uFFFD{3,}/u.test(normalized)) {
    return { detected: true, reason: "replacement_character" };
  }

  if (hasScriptFragmentation(normalized)) {
    return { detected: true, reason: "script_fragmentation" };
  }

  for (const pattern of patterns) {
    if (matchesCustomPattern(normalized, pattern)) {
      return { detected: true, reason: "custom_pattern", pattern };
    }
  }

  return { detected: false };
}

function metadataByModelId(
  modelDbIds: number[],
): Map<number, Omit<RabbitCandidate, keyof RoutingScore | "rabbitScore">> {
  if (modelDbIds.length === 0) return new Map();
  const db = getDb();
  const placeholders = modelDbIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`
      SELECT id, intelligence_rank, size_label, supports_vision, supports_tools, context_window
      FROM models
      WHERE id IN (${placeholders})
    `)
    .all(...modelDbIds) as Array<{
    id: number;
    intelligence_rank: number;
    size_label: string;
    supports_vision: number;
    supports_tools: number;
    context_window: number | null;
  }>;
  return new Map(
    rows.map((row) => [
      row.id,
      {
        intelligenceRank: row.intelligence_rank,
        sizeLabel: row.size_label,
        supportsVision: row.supports_vision === 1,
        supportsTools: row.supports_tools === 1,
        contextWindow: row.context_window,
      },
    ]),
  );
}

function platformsWithEnabledKeys(): Set<string> {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT platform
      FROM api_keys
      WHERE enabled = 1 AND status IN ('healthy', 'unknown', 'error')
      GROUP BY platform
    `)
    .all() as Array<{ platform: string }>;
  return new Set(rows.map((row) => row.platform));
}

export function getRabbitCandidates(
  weights: RoutingWeights = getRabbitWeights(),
): RabbitCandidate[] {
  const routing = getRoutingScores();
  const normalizedWeights = normalizeWeights(weights) ?? RABBIT_DEFAULT_WEIGHTS;
  const keyPlatforms = platformsWithEnabledKeys();
  const metadata = metadataByModelId(
    routing.scores.map((score) => score.modelDbId),
  );

  return routing.scores
    .flatMap((score) => {
      const meta = metadata.get(score.modelDbId);
      if (!meta || !keyPlatforms.has(score.platform)) return [];
      const base = combineScore(
        {
          reliability: score.reliability,
          speed: score.speed,
          intelligence: score.intelligence,
          latency: score.latency,
        },
        normalizedWeights,
      );
      return [
        {
          ...score,
          ...meta,
          rabbitScore: base * score.degradationFactor * score.boost,
        },
      ];
    })
    .sort((a, b) => b.rabbitScore - a.rabbitScore);
}

function orderWithExplicitFirst(
  candidates: RabbitCandidate[],
  modelDbId: number,
): RabbitCandidate[] {
  const preferred = candidates.find(
    (candidate) => candidate.modelDbId === modelDbId,
  );
  if (!preferred) return candidates;
  return [
    preferred,
    ...candidates.filter((candidate) => candidate.modelDbId !== modelDbId),
  ];
}

export function resolveFoundationCandidates(
  config: OscillatorConfig = getOscillatorConfig(),
  candidates: RabbitCandidate[] = getRabbitCandidates(
    config.rabbitWeights ?? RABBIT_DEFAULT_WEIGHTS,
  ),
): RabbitCandidate[] {
  if (typeof config.foundationSelection === "number") {
    return orderWithExplicitFirst(candidates, config.foundationSelection);
  }
  if (config.foundationSelection === "top_rank") {
    return [...candidates].sort(
      (a, b) =>
        a.intelligenceRank - b.intelligenceRank ||
        b.rabbitScore - a.rabbitScore,
    );
  }
  return candidates;
}

function intelligenceGapOk(
  foundation: RabbitCandidate,
  candidate: RabbitCandidate,
  minGap: number,
): boolean {
  return (
    Math.abs(foundation.intelligence - candidate.intelligence) * 100 >= minGap
  );
}

export function resolveInjectionModel(
  config: OscillatorConfig,
  foundationModelDbId: number,
  candidates: RabbitCandidate[] = getRabbitCandidates(
    config.rabbitWeights ?? RABBIT_DEFAULT_WEIGHTS,
  ),
): RabbitCandidate | undefined {
  const foundation = candidates.find(
    (candidate) => candidate.modelDbId === foundationModelDbId,
  );
  if (!foundation) return undefined;

  if (typeof config.injectionSelection === "number") {
    return candidates.find(
      (candidate) =>
        candidate.modelDbId === config.injectionSelection &&
        candidate.modelDbId !== foundation.modelDbId,
    );
  }

  const eligible = candidates.filter(
    (candidate) =>
      candidate.modelDbId !== foundation.modelDbId &&
      intelligenceGapOk(foundation, candidate, config.minIntelligenceGap),
  );
  if (eligible.length === 0) return undefined;

  if (config.injectionSelection === "top_rank") {
    return [...eligible].sort(
      (a, b) =>
        a.intelligenceRank - b.intelligenceRank ||
        b.rabbitScore - a.rabbitScore,
    )[0];
  }

  if (config.injectionSelection === "different_tier") {
    return (
      eligible.find(
        (candidate) => candidate.sizeLabel !== foundation.sizeLabel,
      ) ?? eligible[0]
    );
  }

  return (
    eligible.find((candidate) => candidate.platform !== foundation.platform) ??
    eligible[0]
  );
}
