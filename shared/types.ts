// ---- Platform & Model Types ----

// Active platforms — must match server/src/providers/index.ts and
// server/src/routes/keys.ts PLATFORMS allowlist.
// Moonshot and MiniMax direct integrations were dropped in migrateModelsV4
// (see server/src/db/index.ts). HuggingFace was dropped in V4 and re-added
// in V13 via the router.huggingface.co Inference Providers meta-router.
// SambaNova was dropped in V23 (free tier permanently retired — 402
// "payment method required" once the one-time $5 trial credit lapses).
export type Platform =
  | "google"
  | "groq"
  | "cerebras"
  | "nvidia"
  | "mistral"
  | "openrouter"
  | "github"
  | "cohere"
  | "cloudflare"
  | "zhipu"
  | "ollama"
  | "kilo"
  | "pollinations"
  | "llm7"
  | "huggingface"
  // OpenCode Zen — OpenAI-compatible gateway. Free promotional models require a
  // free (no-card) account key from opencode.ai/auth; see migrateModelsV18.
  | "opencode"
  // OVHcloud AI Endpoints — OpenAI-compatible, keyless anonymous tier
  // (2 req/min per IP per model); see migrateModelsV26.
  | "ovh"
  | "commandcode";
// NOTE: the literal string 'custom' is no longer a special platform. Users add
// their own OpenAI-compatible providers (ollama, llama.cpp, LM Studio, vLLM,
// any base_url) via POST /api/custom-providers, and the resulting slug becomes
// the value in models.platform / api_keys.platform. The router, analytics, and
// health checks key off the platform string and treat it identically to a
// built-in — the only difference is the base URL lives in custom_providers.

// ---- Per-Provider Routing Strategy ------------------------------------------
// The client and the server share this union. The literal 'auto' appears only
// at the per-provider level (never as a global fallback) and routes each
// request through the Thompson-sampling orchestrator.
export type ProviderRoutingStrategy =
  | "priority"
  | "balanced"
  | "smartest"
  | "iterative_refinement"
  | "fastest"
  | "reliable"
  | "custom"
  | "racing"
  | "auto";

// Arms eligible for Auto mode. Excludes `priority` (only the chain order
// decides), `custom` (free-form weighting, not comparable across runs), and
// `iterative_refinement` (multi-turn oscillator state doesn't decompose to a
// single per-request reward signal).
export const AUTO_ARMS: ProviderRoutingStrategy[] = [
  "balanced",
  "smartest",
  "fastest",
  "reliable",
  "racing",
];

// The set of 9 literal strategies allowed in the provider_strategies CHECK
// constraint. Repeated from `ProviderRoutingStrategy` as a value so zod and
// other validators can reference it at runtime.
export const VALID_PROVIDERS_STRATEGIES: readonly ProviderRoutingStrategy[] = [
  "priority",
  "balanced",
  "smartest",
  "iterative_refinement",
  "fastest",
  "reliable",
  "custom",
  "racing",
  "auto",
] as const;

export interface CustomProvider {
  id: number;
  slug: string;
  displayName: string;
  baseUrl: string;
  createdAt: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  maxParallelRequests: number | null;
  keyless: boolean;
  apiFormat: "openai" | "anthropic";
  stickySessionsEnabled: boolean;
  archived: boolean;
}
export interface CustomProviderCreate {
  slug: string;
  displayName: string;
  baseUrl: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  maxParallelRequests?: number | null;
  keyless?: boolean;
  apiFormat?: "openai" | "anthropic";
  stickySessionsEnabled?: boolean;
}

export interface CustomProviderUpdate {
  displayName?: string;
  baseUrl?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  maxParallelRequests?: number | null;
  keyless?: boolean;
  apiFormat?: "openai" | "anthropic";
  stickySessionsEnabled?: boolean;
}

export interface CustomModelCreate {
  providerSlug: string;
  modelId: string;
  displayName: string;
  contextWindow?: number | null;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  monthlyTokenBudget?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
}

export interface CustomModelUpdate {
  displayName?: string;
  contextWindow?: number | null;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  monthlyTokenBudget?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  enabled?: boolean;
}

export interface Model {
  id: number;
  // Built-in platforms (Platform union) plus user-defined slugs from
  // custom_providers. The DB stores arbitrary strings; only the add-key form
  // narrows to the built-in union.
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  groupId?: number | null;
  groupKey?: string | null;
  groupDisplayName?: string | null;
}

export interface ModelListRow {
  platform: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
}

export type KeyStatus =
  | "healthy"
  | "sick"
  | "rate_limited"
  | "invalid"
  | "error"
  | "unknown";

export interface ApiKey {
  id: number;
  platform: string;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  enabled: boolean;
  useProxy: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
}

export interface ApiKeyCreate {
  platform: Platform;
  key: string;
  label?: string;
  useProxy?: boolean;
}

export interface OutboundTransport {
  id: number;
  transportId: string;
  name: string;
  endpointUrl: string;
  maskedAuthKey: string;
  allowedHosts: string;
  placementRegion: string | null;
  enabled: boolean;
  lastDeployedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- Fallback Config ----

export interface FallbackEntry {
  modelId: number;
  platform: Platform;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  priority: number;
  enabled: boolean;
}

// ---- OpenAI-Compatible Types ----

export interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: ChatToolCallFunction;
  thought_signature?: string;
}

export interface ChatToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatToolDefinition {
  type: "function";
  function: ChatToolFunctionDefinition;
}

export type ChatToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

// OpenAI's multimodal envelope: clients like opencode / continue.dev send
// content as an array of typed blocks even for text-only messages, and
// Gemini-lineage agents (Qwen Code, AionUI) send part-style `{ text }` blocks
// with no `type` — plus bare strings inside arrays. We accept all of it on
// the wire and flatten to string for providers that don't support arrays
// (Cohere, Cloudflare). See server/src/lib/content.ts. (#200)
export type ChatContentBlock =
  | string
  | { type?: string; text?: string; [key: string]: unknown };
export type ChatContent = string | null | ChatContentBlock[];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  // The model's thinking trace on an assistant turn. Some thinking models
  // (DeepSeek on OpenCode Zen) require it to be replayed verbatim on the next
  // turn or they 400; the proxy preserves and forwards it. See issue #255.
  reasoning_content?: string | null;
  // Anthropic-specific extended-thinking signature (encrypted reasoning).
  // Required to be replayed alongside `reasoning_content` so multi-turn tool
  // loops don't reject the request. Provider-specific; other providers ignore.
  thinking_signature?: string | null;
}

// Unified thinking-effort hint. Linear scale; providers map to their native
// vocabulary (`thinking.level`, `thinkingBudget`, `output_config.effort`, etc.).
// `xhigh` is Anthropic-only; providers that don't recognize it collapse it to
// `high` so the user's intent is honored.
export type ThinkingEffort =
  | "max"
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal";

// Reasoning trace replay hint. `enabled` carries Anthropic's `budget_tokens`
// (and can coexist with `effort` for the newer Opus 4.6 / Sonnet 4.6 adaptive
// mode). `adaptive` is Anthropic's newer mood; `disabled` is honored where the
// model supports it. Providers that don't understand a given variant drop it.
export interface ThinkingConfig {
  // Anthropic-style: 'enabled' | 'adaptive' | 'disabled'.
  // OpenAI-compat / Google: 'enabled' | 'disabled'.
  type?: "enabled" | "adaptive" | "disabled";
  effort?: ThinkingEffort;
  // Anthropic budget_tokens; Google Gemini 2.5 thinkingBudget. Optional.
  budget?: number;
  // Anthropic display hint ('summarized' | 'omitted'). Optional.
  display?: "summarized" | "omitted";
  // Google, also returned by some OpenAI-compat providers: include the raw
  // (non-summarized) reasoning trace in the response. Default true when
  // thinking is enabled.
  includeThoughts?: boolean;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  // OpenAI-compat "reasoning_effort" field. Equivalent to
  // thinking.effort but separate for clients that already use it. Providers
  // normalize into their native thinking config. (#290)
  reasoning_effort?: ThinkingEffort;
  // Richer thinking-control object. Forwarded per-provider with shape
  // adaptation (`thinking` for Anthropic, `thinkingConfig` for Google,
  // `reasoning_effort`/`reasoning` for OpenAI-compat). (#290)
  thinking?: ThinkingConfig;
}
export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number; // thinking/reasoning tokens produced by the model
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

// ---- Heartbeat Advisor Types ----

export interface AdvisoryPayload {
  self: { provider: string; model: string };
  keys: Array<{
    keyId: number;
    models: Array<{
      model: string;
      healthy: boolean;
      penalty: number;
      lastError?: string;
      lastPingLatencyMs?: number;
      stats?: {
        tokPerSec: number;
        avgTtfbMs: number | null;
        successes: number;
        failures: number;
        totalRequests: number;
      };
      advisor?: {
        score: number;
        confidence: number;
        updatedAt: number | null;
      };
      cooldownActive: boolean;
      cooldownTier?: number;
    }>;
  }>;
  models: Array<{
    model: string;
    provider: string;
    stats: {
      successRate: number;
      avgLatencyMs: number;
      p95LatencyMs?: number;
      tokPerSec: number;
      avgTtfbMs: number | null;
    };
    degradation?: {
      penalty: number;
      tier: string;
      consecutiveFailures: number;
      boost: number;
    };
  }>;
  cooldowns: Array<{
    keyId: number;
    model: string;
    tier: number;
    remainingMs: number;
  }>;
  dailyUsage: Array<{
    keyId: number;
    requestCount: number;
    dailyCap: number | null;
  }>;
  routing: {
    strategy: string;
    customWeights?: Record<string, number>;
  };
  oscillator?: {
    attempts: number;
    successes: number;
    failures: number;
    avgLatencyMs: number;
    anomalyCount: number;
    loadShedActive: boolean;
  };
}

export interface RoutingAdvice {
  confidence: number;
  selfScore: number;
  alt?: string;
  cooldownHint: number;
  recheckSooner: boolean;
  oscillatorHint?: "enable" | "disable" | "no_opinion";
  injectionModel?: string;
  injectionBrevity?: "shorter" | "longer" | "default";
}

export interface AdviceResult {
  applied:
    | "score_boost"
    | "score_penalty"
    | "cooldown_extend"
    | "cooldown_reduce"
    | "recheck_scheduled"
    | "alt_suggested"
    | "key_score_boost"
    | "key_score_penalty"
    | "oscillator_toggled"
    | "injection_adjusted"
    | "no_opinion"
    | "parse_error";
  modelDbId?: number;
  magnitude: number;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: ChatToolCall[];
      // Streaming reasoning trace delta. Anthropic's `thinking_delta` and
      // Gemini's `thought:true` parts arrive as incremental strings here.
      // (#290)
      reasoning_content?: string;
      // Anthropic thought signature — emitted once per turn, on the chunk
      // that closes the thinking block. Clients persist it for replay. (#290)
      thinking_signature?: string;
    };
    finish_reason: string | null;
  }[];
  usage?: TokenUsage;
}

// ---- Analytics Types ----

export interface AnalyticsSummary {
  totalRequests: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  pinnedRequests: number;
  pinHonoredRequests: number;
}

export interface PlatformStats {
  platform: Platform;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface TimelinePoint {
  timestamp: string;
  requests: number;
  successCount: number;
  failureCount: number;
}

export interface ModelTimelineSeries {
  key: string;
  platform: string;
  modelId: string;
  displayName: string;
  requests: number;
}

export interface ModelTimelineResponse {
  series: ModelTimelineSeries[];
  points: Array<Record<string, string | number>>;
}

export interface RequestLog {
  id: number;
  platform: Platform;
  modelId: string;
  status: "success" | "error";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

export interface ModelStats {
  platform: string;
  modelId: string;
  displayName: string;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  pinnedRequests: number;
  tokPerSec: number;
}

export interface ErrorEntry {
  id: number;
  platform: string;
  modelId: string;
  error: string | null;
  latencyMs: number;
  createdAt: string;
}

export interface HourlyStat {
  // Local hour of day, 0-23.
  hour: number;
  requests: number;
  // Average response time in ms across all requests in this hour (lower = more productive).
  avgLatencyMs: number;
  // Average output tokens per second (incl reasoning) across requests in this hour (higher = more productive).
  avgTokPerSec: number;
  // Error rate as a percentage 0-100 (lower = more productive).
  errorRate: number;
  successRate: number;
}

// Collapsed 24-bucket stats derived from the ping_history table. Mirrors
// HourlyStat's shape but reports only the baseline "hi" probes that fire
// whether or not the router is serving traffic.
export interface PingHourlyStat {
  hour: number;
  requests: number;
  avgLatencyMs: number;
  errorRate: number;
  successRate: number;
}

// Per-model hourly productivity buckets. Mirrors HourlyStat's shape.
export interface ModelHourlyStat {
  hour: number;
  requests: number;
  avgLatencyMs: number;
  avgTokPerSec: number;
  errorRate: number;
  successRate: number;
}

// All-model hourly breakdown with per-model zero-filled buckets.
export interface ModelHourlyResponse {
  models: Array<{
    platform: string;
    modelId: string;
    displayName: string;
    totalRequests: number;
    /** Per-UTC-hour stats, zero-filled to length 24 (index = hour). */
    hourly: ModelHourlyStat[];
  }>;
}

export interface ErrorDistribution {
  byCategory: { category: string; count: number }[];
  byPlatform: { platform: string; count: number }[];
  detailed: {
    platform: string;
    model_id: string;
    error_category: string;
    count: number;
  }[];
}

// ---- Rate Limit Types ----

export interface RateLimitStatus {
  platform: Platform;
  modelId: string;
  rpm: { used: number; limit: number | null };
  rpd: { used: number; limit: number | null };
  tpm: { used: number; limit: number | null };
  available: boolean;
  nextResetAt: string | null;
}
