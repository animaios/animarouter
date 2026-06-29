import type {
  AdvisoryPayload,
  ChatMessage,
} from "@animarouter/shared/types.js";
import { getDb } from "../db/index.js";
import {
  buildContextBridge,
  type ContextBridgeResult,
} from "./context-bridge.js";
import type { ContextHandoffMode } from "./context-handoff.js";
import { getFeatureSetting } from "./feature-settings.js";
import {
  getProviderInFlightTotal,
  getRoutingScores,
  type RoutingScore,
} from "./router.js";
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
  foundationSelection: FoundationSelection;
  injectionSelection: InjectionSelection;
  iterativeRefinementWeights?: RoutingWeights;
  minIntelligenceGap: number;
  injectionMaxSentences: number;
  anomalyPatterns: string[];
  loadShedThreshold: number;
  stepTimeoutMs: number;
  fallbackMode: "foundation_only" | "injection_only";
}

export interface IterativeRefinementCandidate extends RoutingScore {
  intelligenceRank: number;
  sizeLabel: string;
  supportsVision: boolean;
  supportsTools: boolean;
  contextWindow: number | null;
  iterativeRefinementScore: number;
}

export interface IterativeRefinementEligibilityInput {
  strategy: RoutingStrategy;
  pinnedModelDbId?: number | null;
  loadShedActive?: boolean;
  config?: OscillatorConfig;
}

export interface IterativeRefinementOscillatorDecision {
  mode: "oscillator" | "single_model";
  config: OscillatorConfig;
  loadShedActive: boolean;
  skipReason?: "non_iterative_refinement_strategy" | "pinned_model" | "load_shed";
}

export interface IterativeRefinementOscillatorDecisionInput
  extends IterativeRefinementEligibilityInput {
  currentConcurrent?: number;
}

export interface AnomalyDetectionResult {
  detected: boolean;
  reason?:
    | "custom_pattern"
    | "structural_tag"
    | "repeated_character"
    | "replacement_character"
    | "script_fragmentation";
  pattern?: string;
}

export type OscillatorStep = "foundation" | "injection" | "anchor";

export interface OscillatorModelCallInput {
  step: OscillatorStep;
  candidate: IterativeRefinementCandidate;
  messages: ChatMessage[];
  onChunk?: (delta: string, accumulated: string) => void;
}

export type OscillatorModelCallResult =
  | string
  | {
      text?: string | null;
      toolCalls?: ChatToolCall[];
    }
  | null
  | undefined;

export type OscillatorModelCall = (
  input: OscillatorModelCallInput,
) => Promise<OscillatorModelCallResult>;

export interface OscillatorStreamChunk {
  step: OscillatorStep;
  delta: string;
  accumulated: string;
  stepComplete: boolean;
  final?: ExecuteOscillatorResult;
}

export interface ExecuteOscillatorParams {
  messages: ChatMessage[];
  sessionKey: string;
  callModel: OscillatorModelCall;
  config?: OscillatorConfig;
  candidates?: IterativeRefinementCandidate[];
  handoffMode?: ContextHandoffMode;
  stream?: boolean;
  onChunk?: (chunk: OscillatorStreamChunk) => void;
}

import type { ChatToolCall } from "@animarouter/shared/types.js";

export interface ExecuteOscillatorResult {
  status: "completed" | "foundation_fallback" | "single_model_fallback";
  text?: string;
  toolCalls?: ChatToolCall[];
  foundation?: IterativeRefinementCandidate;
  injection?: IterativeRefinementCandidate;
  foundationText?: string;
  injectionText?: string;
  anchorText?: string;
  failedStep?: OscillatorStep | "validation";
  foundationAttempts: number;
  bridges: {
    injection?: ContextBridgeResult;
    anchor?: ContextBridgeResult;
  };
  anomaly?: AnomalyDetectionResult;
  error?: string;
}

export interface OscillatorStepLatencies {
  foundation?: number;
  injection?: number;
  anchor?: number;
}

export interface LogOscillatorResultInput {
  sessionKey: string;
  result: ExecuteOscillatorResult;
  totalLatencyMs: number;
  stepLatencies?: OscillatorStepLatencies;
}

export const ITERATIVE_REFINEMENT_DEFAULT_WEIGHTS: RoutingWeights =
  BANDIT_PRESETS.smartest;

const DEFAULT_ANOMALY_PATTERNS = [
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

export function parseIterativeRefinementWeights(
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

export function getIterativeRefinementWeights(): RoutingWeights {
  return (
    parseIterativeRefinementWeights(
      getFeatureSetting("iterative_refinement_weights") as string,
    ) ?? ITERATIVE_REFINEMENT_DEFAULT_WEIGHTS
  );
}

export function getOscillatorConfig(): OscillatorConfig {
  return {
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
    iterativeRefinementWeights: parseIterativeRefinementWeights(
      getFeatureSetting("iterative_refinement_weights") as string,
    ),
    minIntelligenceGap: getFeatureSetting(
      "oscillator_min_intelligence_gap",
    ) as number,
    injectionMaxSentences: getFeatureSetting(
      "oscillator_injection_max_sentences",
    ) as number,
    anomalyPatterns: DEFAULT_ANOMALY_PATTERNS,
    loadShedThreshold: getFeatureSetting(
      "oscillator_load_shed_threshold",
    ) as number,
    stepTimeoutMs: getFeatureSetting("oscillator_step_timeout_ms") as number,
    fallbackMode: "foundation_only",
  };
}

export function isIterativeRefinementLoadShedActive(
  config: OscillatorConfig = getOscillatorConfig(),
  currentConcurrent = getProviderInFlightTotal(),
): boolean {
  return (
    config.loadShedThreshold > 0 && currentConcurrent > config.loadShedThreshold
  );
}



export function getIterativeRefinementOscillatorDecision(
  input: IterativeRefinementOscillatorDecisionInput,
): IterativeRefinementOscillatorDecision {
  const config = input.config ?? getOscillatorConfig();
  const loadShedActive =
    input.loadShedActive ??
    isIterativeRefinementLoadShedActive(config, input.currentConcurrent);

  if (input.strategy !== "iterative_refinement") {
    return {
      mode: "single_model",
      config,
      loadShedActive,
      skipReason: "non_iterative_refinement_strategy",
    };
  }
  if (input.pinnedModelDbId != null) {
    return {
      mode: "single_model",
      config,
      loadShedActive,
      skipReason: "pinned_model",
    };
  }
  if (loadShedActive) {
    return {
      mode: "single_model",
      config,
      loadShedActive,
      skipReason: "load_shed",
    };
  }
  return { mode: "oscillator", config, loadShedActive };
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

export function detectAnomaly(
  text: string,
  patterns: string[] = DEFAULT_ANOMALY_PATTERNS,
): AnomalyDetectionResult {
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
): Map<
  number,
  Omit<
    IterativeRefinementCandidate,
    keyof RoutingScore | "iterativeRefinementScore"
  >
> {
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

export function getIterativeRefinementCandidates(
  weights: RoutingWeights = getIterativeRefinementWeights(),
): IterativeRefinementCandidate[] {
  const routing = getRoutingScores();
  const normalizedWeights =
    normalizeWeights(weights) ?? ITERATIVE_REFINEMENT_DEFAULT_WEIGHTS;
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
          iterativeRefinementScore:
            base * score.degradationFactor * score.boost,
        },
      ];
    })
    .sort((a, b) => b.iterativeRefinementScore - a.iterativeRefinementScore);
}

function orderWithExplicitFirst(
  candidates: IterativeRefinementCandidate[],
  modelDbId: number,
): IterativeRefinementCandidate[] {
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
  candidates: IterativeRefinementCandidate[] = getIterativeRefinementCandidates(
    config.iterativeRefinementWeights ?? ITERATIVE_REFINEMENT_DEFAULT_WEIGHTS,
  ),
): IterativeRefinementCandidate[] {
  if (typeof config.foundationSelection === "number") {
    return orderWithExplicitFirst(candidates, config.foundationSelection);
  }
  if (config.foundationSelection === "top_rank") {
    return [...candidates].sort(
      (a, b) =>
        a.intelligenceRank - b.intelligenceRank ||
        b.iterativeRefinementScore - a.iterativeRefinementScore,
    );
  }
  return candidates;
}

function intelligenceGapOk(
  foundation: IterativeRefinementCandidate,
  candidate: IterativeRefinementCandidate,
  minGap: number,
): boolean {
  return (
    Math.abs(foundation.intelligence - candidate.intelligence) * 100 >= minGap
  );
}

export function resolveInjectionModel(
  config: OscillatorConfig,
  foundationModelDbId: number,
  candidates: IterativeRefinementCandidate[] = getIterativeRefinementCandidates(
    config.iterativeRefinementWeights ?? ITERATIVE_REFINEMENT_DEFAULT_WEIGHTS,
  ),
): IterativeRefinementCandidate | undefined {
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
        b.iterativeRefinementScore - a.iterativeRefinementScore,
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

function candidateKey(candidate: IterativeRefinementCandidate): string {
  return `${candidate.platform}:${candidate.modelId}`;
}

function asText(result: OscillatorModelCallResult): string {
  if (!result) return "";
  return typeof result === "string" ? result : (result.text ?? "");
}

function hasToolCalls(result: OscillatorModelCallResult): boolean {
  return (
    result != null &&
    typeof result !== "string" &&
    (result as { toolCalls?: ChatToolCall[] }).toolCalls != null &&
    (result as { toolCalls?: ChatToolCall[] }).toolCalls!.length > 0
  );
}

function extractToolCalls(result: OscillatorModelCallResult): ChatToolCall[] | undefined {
  if (result == null || typeof result === "string") return undefined;
  return (result as { toolCalls?: ChatToolCall[] }).toolCalls;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withStepTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  step: OscillatorStep,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Iterative Refinement ${step} step timed out`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function prependSystemMessage(
  messages: ChatMessage[],
  content: string,
): ChatMessage[] {
  return [{ role: "system", content }, ...messages];
}

function injectionInstruction(maxSentences: number): string {
  const sentenceLimit = Math.max(1, Math.floor(maxSentences));
  const sentenceWord = sentenceLimit === 1 ? "sentence" : "sentences";
  return [
    "You are the Iterative Refinement injection step.",
    "Check the thought context and user request for loops, brittle assumptions, or missing alternatives.",
    `Return exactly ${sentenceLimit} ${sentenceWord}.`,
    "Do not include raw system tags, XML tags, markdown fences, or analysis headings.",
  ].join(" ");
}

function anchorInstruction(): string {
  return [
    "You are the Iterative Refinement anchor step.",
    "Synthesize the final answer for the user using the original request and the Iterative Refinement injection context.",
    "Do not expose routing internals, thought-context labels, or structural tags.",
  ].join(" ");
}

async function callStep(params: {
  step: OscillatorStep;
  candidate: IterativeRefinementCandidate;
  messages: ChatMessage[];
  callModel: OscillatorModelCall;
  timeoutMs: number;
  onChunk?: (delta: string, accumulated: string) => void;
}): Promise<OscillatorModelCallResult> {
  const result = await withStepTimeout(
    params.callModel({
      step: params.step,
      candidate: params.candidate,
      messages: params.messages,
      onChunk: params.onChunk,
    }),
    params.timeoutMs,
    params.step,
  );
  const text = asText(result).trim();
  if (!text && !hasToolCalls(result))
    throw new Error(
      `Iterative Refinement ${params.step} step returned empty text`,
    );
  return result;
}

function limitSentences(text: string, maxSentences: number): string {
  const sentenceLimit = Math.max(1, Math.floor(maxSentences));
  const matches =
    text
      .match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)
      ?.map((part) => part.trim()) ?? [];
  if (matches.length <= sentenceLimit) return text;
  return matches.slice(0, sentenceLimit).join(" ").trim();
}

export async function executeOscillator(
  params: ExecuteOscillatorParams,
): Promise<ExecuteOscillatorResult> {
  const config = params.config ?? getOscillatorConfig();
  const candidates =
    params.candidates ??
    getIterativeRefinementCandidates(
      config.iterativeRefinementWeights ?? ITERATIVE_REFINEMENT_DEFAULT_WEIGHTS,
    );
  const foundations = resolveFoundationCandidates(config, candidates);
  const handoffMode = params.handoffMode ?? "off";
  const stream = params.stream ?? false;
  const onChunk = params.onChunk;
  let lastFoundationError: string | undefined;
  let foundationAttempts = 0;

  const emitChunk = (chunk: OscillatorStreamChunk) => {
    if (onChunk) onChunk(chunk);
  };

  for (const foundation of foundations) {
    foundationAttempts++;
    try {
      // Foundation step
      let foundationResult: OscillatorModelCallResult;
      const foundationStreamHandler = stream
        ? (delta: string, accumulated: string) => {
            emitChunk({
              step: "foundation",
              delta,
              accumulated,
              stepComplete: false,
            });
          }
        : undefined;

      foundationResult = await callStep({
        step: "foundation",
        candidate: foundation,
        messages: params.messages,
        callModel: params.callModel,
        timeoutMs: config.stepTimeoutMs,
        onChunk: foundationStreamHandler,
      });

      const foundationText = asText(foundationResult).trim();
      const foundationToolCalls = extractToolCalls(foundationResult);

      emitChunk({
        step: "foundation",
        delta: "",
        accumulated: foundationText,
        stepComplete: true,
      });

      // Foundation returned tool_calls — short-circuit: the client's agent
      // loop must execute the tool before the next turn, so injection and
      // anchor refinement cannot improve a structured tool call anyway.
      // Return with status "completed" and include the tool_calls payload.
      if (foundationToolCalls && foundationToolCalls.length > 0) {
        const result: ExecuteOscillatorResult = {
          status: "completed",
          text: foundationText || undefined,
          toolCalls: foundationToolCalls,
          foundation,
          foundationText,
          foundationAttempts,
          bridges: {},
        };
        if (stream)
          emitChunk({
            step: "foundation",
            delta: "",
            accumulated: foundationText,
            stepComplete: true,
            final: result,
          });
        return result;
      }

      if (!foundationText) {
        // Foundation returned neither text nor tool_calls — try next candidate
        lastFoundationError = `Iterative Refinement foundation step returned empty text`;
        continue;
      }

      const injection = resolveInjectionModel(
        config,
        foundation.modelDbId,
        candidates,
      );
      if (!injection) {
        const result: ExecuteOscillatorResult = {
          status: "foundation_fallback",
          text: foundationText,
          foundation,
          foundationText,
          failedStep: "injection",
          foundationAttempts,
          bridges: {},
          error: "No eligible Iterative Refinement injection model",
        };
        if (stream)
          emitChunk({
            step: "foundation",
            delta: "",
            accumulated: foundationText,
            stepComplete: true,
            final: result,
          });
        return result;
      }

      const injectionBridge = buildContextBridge({
        mode: handoffMode,
        sessionKey: params.sessionKey,
        messages: prependSystemMessage(
          params.messages,
          injectionInstruction(config.injectionMaxSentences),
        ),
        selectedModelKey: candidateKey(injection),
        sourceProvider: foundation.platform,
        isOscillatorHandoff: true,
        priorResponseText: foundationText,
      });

      let injectionText: string;
      let injectionAccumulated = "";
      const injectionStreamHandler = stream
        ? (delta: string, accumulated: string) => {
            injectionAccumulated = accumulated;
            emitChunk({
              step: "injection",
              delta,
              accumulated,
              stepComplete: false,
            });
          }
        : undefined;

      try {
        injectionText = asText(
          await callStep({
            step: "injection",
            candidate: injection,
            messages: injectionBridge.messages,
            callModel: params.callModel,
            timeoutMs: config.stepTimeoutMs,
            onChunk: injectionStreamHandler,
          }),
        );
        injectionText = limitSentences(
          injectionText,
          config.injectionMaxSentences,
        );
        injectionAccumulated = injectionText;
      } catch (error) {
        const result: ExecuteOscillatorResult = {
          status: "foundation_fallback",
          text: foundationText,
          foundation,
          injection,
          foundationText,
          failedStep: "injection",
          foundationAttempts,
          bridges: { injection: injectionBridge },
          error: errorMessage(error),
        };
        if (stream) {
          emitChunk({
            step: "injection",
            delta: "",
            accumulated: injectionAccumulated,
            stepComplete: true,
            final: result,
          });
        }
        return result;
      }

      emitChunk({
        step: "injection",
        delta: "",
        accumulated: injectionAccumulated,
        stepComplete: true,
      });

      const anchorBridge = buildContextBridge({
        mode: handoffMode,
        sessionKey: params.sessionKey,
        messages: prependSystemMessage(params.messages, anchorInstruction()),
        selectedModelKey: candidateKey(foundation),
        sourceProvider: injection.platform,
        isOscillatorHandoff: true,
        priorResponseText: injectionText,
      });

      let anchorText: string;
      let anchorAccumulated = "";
      const anchorStreamHandler = stream
        ? (delta: string, accumulated: string) => {
            anchorAccumulated = accumulated;
            emitChunk({
              step: "anchor",
              delta,
              accumulated,
              stepComplete: false,
            });
          }
        : undefined;

      try {
        anchorText = asText(
          await callStep({
            step: "anchor",
            candidate: foundation,
            messages: anchorBridge.messages,
            callModel: params.callModel,
            timeoutMs: config.stepTimeoutMs,
            onChunk: anchorStreamHandler,
          }),
        );
        anchorAccumulated = anchorText;
      } catch (error) {
        const result: ExecuteOscillatorResult = {
          status: "foundation_fallback",
          text: foundationText,
          foundation,
          injection,
          foundationText,
          injectionText,
          failedStep: "anchor",
          foundationAttempts,
          bridges: { injection: injectionBridge, anchor: anchorBridge },
          error: errorMessage(error),
        };
        if (stream) {
          emitChunk({
            step: "anchor",
            delta: "",
            accumulated: anchorAccumulated,
            stepComplete: true,
            final: result,
          });
        }
        return result;
      }

      emitChunk({
        step: "anchor",
        delta: "",
        accumulated: anchorAccumulated,
        stepComplete: true,
      });

      const anomaly = detectAnomaly(anchorText, config.anomalyPatterns);
      if (anomaly.detected) {
        const result: ExecuteOscillatorResult = {
          status: "foundation_fallback",
          text: foundationText,
          foundation,
          injection,
          foundationText,
          injectionText,
          anchorText,
          failedStep: "validation",
          foundationAttempts,
          bridges: { injection: injectionBridge, anchor: anchorBridge },
          anomaly,
        };
        if (stream) {
          emitChunk({
            step: "anchor",
            delta: "",
            accumulated: anchorAccumulated,
            stepComplete: true,
            final: result,
          });
        }
        return result;
      }

      const result: ExecuteOscillatorResult = {
        status: "completed",
        text: anchorText,
        foundation,
        injection,
        foundationText,
        injectionText,
        anchorText,
        foundationAttempts,
        bridges: { injection: injectionBridge, anchor: anchorBridge },
        anomaly,
      };

      if (stream) {
        emitChunk({
          step: "anchor",
          delta: "",
          accumulated: anchorAccumulated,
          stepComplete: true,
          final: result,
        });
      }

      return result;
    } catch (error) {
      lastFoundationError = errorMessage(error);
    }
  }

  const result: ExecuteOscillatorResult = {
    status: "single_model_fallback",
    failedStep: "foundation",
    foundationAttempts,
    bridges: {},
    error:
      lastFoundationError ??
      "No eligible Iterative Refinement foundation model",
  };

  if (stream) {
    emitChunk({
      step: "foundation",
      delta: "",
      accumulated: "",
      stepComplete: true,
      final: result,
    });
  }

  return result;
}

function failedStepNumber(
  step: ExecuteOscillatorResult["failedStep"],
): number | null {
  if (step === "foundation") return 1;
  if (step === "injection") return 2;
  if (step === "anchor" || step === "validation") return 3;
  return null;
}

function strippedArtifactCount(result: ExecuteOscillatorResult): number {
  return (
    (result.bridges.injection?.strippedArtifacts ?? 0) +
    (result.bridges.anchor?.strippedArtifacts ?? 0)
  );
}

function positiveIntegerOrNull(value: number | undefined): number | null {
  if (!Number.isFinite(value) || value == null) return null;
  return Math.max(0, Math.round(value));
}

export function logOscillatorResult(input: LogOscillatorResultInput): void {
  const db = getDb();
  const complete = input.result.status === "completed" ? 1 : 0;
  db.prepare(`
    INSERT INTO oscillator_results (
      session_key,
      foundation_model_db_id,
      injection_model_db_id,
      step1_latency_ms,
      step2_latency_ms,
      step3_latency_ms,
      total_latency_ms,
      complete,
      failed_step,
      status,
      anomaly_detected,
      stripped_artifacts
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionKey,
    input.result.foundation?.modelDbId ?? null,
    input.result.injection?.modelDbId ?? null,
    positiveIntegerOrNull(input.stepLatencies?.foundation),
    positiveIntegerOrNull(input.stepLatencies?.injection),
    positiveIntegerOrNull(input.stepLatencies?.anchor),
    Math.max(0, Math.round(input.totalLatencyMs)),
    complete,
    failedStepNumber(input.result.failedStep),
    input.result.status,
    input.result.anomaly?.detected ? 1 : 0,
    strippedArtifactCount(input.result),
  );
}

export function collectOscillatorStats(
  windowMs: number,
  now = Date.now(),
): NonNullable<AdvisoryPayload["oscillator"]> {
  const db = getDb();
  const since = new Date(now - Math.max(0, windowMs))
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS attempts,
        SUM(CASE WHEN complete = 1 THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN complete = 0 THEN 1 ELSE 0 END) AS failures,
        AVG(CASE WHEN complete = 1 THEN total_latency_ms ELSE NULL END) AS avg_latency_ms,
        SUM(anomaly_detected) AS anomaly_count
      FROM oscillator_results
      WHERE created_at >= ?
    `)
    .get(since) as
    | {
        attempts: number | null;
        successes: number | null;
        failures: number | null;
        avg_latency_ms: number | null;
        anomaly_count: number | null;
      }
    | undefined;

  return {
    attempts: row?.attempts ?? 0,
    successes: row?.successes ?? 0,
    failures: row?.failures ?? 0,
    avgLatencyMs: Math.round(row?.avg_latency_ms ?? 0),
    anomalyCount: row?.anomaly_count ?? 0,
    loadShedActive: isIterativeRefinementLoadShedActive(),
  };
}
