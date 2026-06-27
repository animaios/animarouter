# Heartbeat AI Routing Advisor — Design Document

## 1. Architecture Overview

The advisory system operates at **two levels**:

1. **Heartbeat-level advisory** (existing v1 design) — each heartbeat ping carries operational telemetry, the model's response is parsed for routing adjustments.
2. **Request-level Rabbit Shake AI routing strategy** (v2 expansion) — when the Rabbit/AI routing strategy is active and the request qualifies, the router executes a 3-step sequential multi-model pipeline instead of a single model call, injecting divergent reasoning to break logic loops.

Both levels share the same **Context Bridge & Sanitization** layer, which prevents token collisions and context corruption when crossing provider boundaries.

### 1.1 How the Two Levels Interact

The heartbeat advisor runs passively during health checks. The Rabbit Shake oscillator runs actively during user request processing. They feed each other:

```
┌─────────────────────────────────────────────────────────────┐
│                         runCycle()                           │
│                                                              │
│  pingKey() with advisory payload:                            │
│    1. buildAdvisoryPayload() → operational summary          │
│    2. Send advisory prompt (not "hi")                        │
│    3. Parse → RoutingAdvice                                  │
│    4. applyAdvice() → score adjustments, cooldown hints     │
│                                                              │
│  ★ New: Rabbit Shake metrics feed BACK into payload:        │
│    - oscillator success/failure rates                        │
│    - per-model-pair latency & coherence scores              │
│    - meow detection counts                                   │
└──────────────────┬──────────────────────────────────────────┘
                   │ advisory adjustments
                   ▼
┌─────────────────────────────────────────────────────────────┐
│                  request pipeline (proxy.ts)                 │
│                                                              │
│  Normal path: single model → response                       │
│                                                              │
│  ★ New: Rabbit Shake AI strategy path (when eligible):      │
│    1. [Foundation] Smartest-weighted model → base           │
│       ↓ Context Bridge (sanitize + handoff)                 │
│    2. [Injection] Divergent eligible model → critique       │
│       ↓ Context Bridge (sanitize + handoff)                 │
│    3. [Anchor] Foundation model → final synthesis           │
│       ↓                                                      │
│    meow validation → accept or fallback                     │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Existing Infrastructure We Piggyback On

| Existing System | Rabbit Shake Usage |
|---|---|
| `context-handoff.ts` (`maybeInjectContextHandoff`) | Already injects a structured handoff message when the model switches mid-session. The oscillator uses the **same mechanism** but with an **extended handoff** that carries the prior model's cleaned output. |
| `context-handoff.ts` (`recordIncomingMessages`, `recordSuccessfulModel`) | Already tracks per-session model history. The oscillator reads this to determine if a conversation is already mid-oscillation. |
| `tool-call-rescue.ts` (`parseTokenDialect`) | Already strips `<|tool_call_begin|>` and other provider-specific special tokens. The Context Bridge reuses this for **response-level token stripping** during inter-model handoff. |
| `error-redaction.ts` (`sanitizeProviderErrorMessage`) | Already strips sensitive info from error strings. The Context Bridge uses this to sanitize error context before passing to the next model. |
| `providers/google.ts` (`sanitizeForGemini`) | Already strips provider-specific schema artifacts. We generalize this pattern for all providers. |
| `providers/base.ts` (`readSseStream`) | Stream parsing already normalizes OpenAI-wire SSE into a common format. The oscillator builds on this for intermediate-step streaming. |

### 1.3 Rabbit Shake as a Routing Strategy (AI Mode)

Rabbit Shake should be exposed as a first-class routing strategy, labeled **AI mode** in operator-facing controls. It is distinct from the existing single-call strategies:

| Strategy | Request behavior |
|---|---|
| `priority` | Manual order, single-model routing |
| `balanced` / `smartest` / `fastest` / `reliable` / `custom` | Weighted single-model routing |
| `ai` / Rabbit Shake | Smartest-weight foundation selection plus optional 3-step oscillator for eligible reasoning prompts |

AI mode must reuse the same route eligibility filters as normal routing: enabled model, matching capabilities, available key, health/degradation state, budget limits, and request constraints. It should not use a static provider/model pair.

Foundation candidates are ordered with the existing **Smartest** preset unless the operator explicitly configures custom AI weights:

```typescript
const RABBIT_AI_DEFAULT_WEIGHTS: RoutingWeights = {
  intelligence: 0.45,
  reliability: 0.30,
  latency: 0.15,
  speed: 0.10,
};
```

Those weights produce the ordered foundation candidate list. Step 1 tries candidates in that order until one succeeds or the list is exhausted. The injection model is selected after the foundation succeeds, using the same eligible pool but preferring a different provider or tier so it can add a genuinely different reasoning angle.

If the request is not oscillator-eligible, if load shedding is active, or if all Step 1 foundation candidates fail, AI mode must fall back to normal best-eligible single-model routing using the same Smartest-weight ordering.

### 1.4 Key Insight: The Budget Trick (unchanged from v1)

Current pings: `max_tokens: 5`, temperature `0`, content `"hi"`. Advisory pings keep the same output budget but replace the input with a structured telemetry payload (~200–400 input tokens).

---

## 2. Core Data Model

### 2.1 Advisory Payload Structure (updated with oscillator metrics)

The payload sent to the model during heartbeat advisory pings:

```typescript
interface AdvisoryPayload {
  /** Which provider + model is being pinged */
  self: { provider: string; model: string };
  
  /** Per-key health snapshot for this provider */
  keys: Array<{
    keyId: number;
    models: Array<{
      model: string;
      healthy: boolean;
      penalty: number;
      lastError?: string;
      lastPingLatencyMs?: number;
      cooldownActive: boolean;
      cooldownTier?: number;
    }>;
  }>;

  /** Per-model performance from the requests table (decay-weighted) */
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

  /** Active rate-limit cooldowns across all keys for this provider */
  cooldowns: Array<{
    keyId: number;
    model: string;
    tier: number;
    remainingMs: number;
  }>;

  /** Provider-level daily usage vs. caps */
  dailyUsage: Array<{
    keyId: number;
    requestCount: number;
    dailyCap: number | null;
  }>;

  /** Current routing strategy and weights */
  routing: {
    strategy: string;
    customWeights?: Record<string, number>;
    aiWeights?: Record<string, number>;
  };

  // ─── ★ NEW: Oscillator metrics ─────────────────────────────

  /** Rabbit Shake oscillator performance (last N cycles) */
  oscillator?: {
    /** How many oscillator-mode requests were attempted in this scoring window */
    attempts: number;
    /** How many completed all 3 steps without timeout or meow validation failure */
    successes: number;
    /** How many were terminated early (timeout, meow detected, load-shed) */
    failures: number;
    /** Average end-to-end latency for full 3-step oscillator (ms) */
    avgLatencyMs: number;
    /** Meow detection count — responses flagged as incoherent/corrupted */
    meowCount: number;
    /** Whether the oscillator is currently load-shed disabled */
    loadShedActive: boolean;
  };
}
```

### 2.2 Advisory Response Schema

```typescript
interface RoutingAdvice {
  /** Confidence in the advice (0‑9) — 0 = no opinion */
  confidence: number;
  
  /** Score adjustment for the pinged model: -9 to +9 */
  selfScore: number;
  
  /** Score adjustment for another model/provider */
  alt?: string;

  /** Cooldown advice: 0 = none, 1 = extend 50%, 2 = cut 50% */
  cooldownHint: number;
  
  /** Whether to try a recheck sooner */
  recheckSooner: boolean;

  // ─── ★ NEW: Oscillator-specific advice ─────────────────────

  /** Whether to enable/disable the oscillator based on current conditions */
  oscillatorHint?: 'enable' | 'disable' | 'no_opinion';

  /** Suggested injection model override (can specify provider:model or intelligence_rank:N) */
  injectionModel?: string;

  /** Suggested injection brevity: reduce or increase the 2-sentence limit */
  injectionBrevity?: 'shorter' | 'longer' | 'default';
}
```

### 2.3 Rabbit Shake Oscillator Configuration

```typescript
interface OscillatorConfig {
  /** Whether the 3-step oscillator is enabled */
  enabled: boolean;

  /**
   * How to select the foundation model (Step 1 & 3):
   * - 'auto' (default): eligible models ordered by Rabbit AI / Smartest weights
   * - 'top_rank': the model with intelligence_rank = 1 (if available)
   * - model_db_id: explicit model DB ID override
   *
   * Selection is model-agnostic. GLM, Nemotron, or any other model may become
   * the foundation if it is the top Smartest-weight candidate in the local pool.
   * If the preferred foundation fails before producing Step 1 output, the
   * resolver should advance to the next eligible high-intelligence candidate.
   */
  foundationSelection: 'auto' | 'top_rank' | number;

  /**
   * How to select the injection model (Step 2):
   * - 'divergent' (default): a model with HIGH intelligence but DIFFERENT provider
   *   than the foundation, maximizing reasoning diversity
   * - 'top_rank': the highest-intelligence model regardless of provider
   * - 'different_tier': a model from a different size tier than foundation
   * - model_db_id: explicit model DB ID override
   *
   * Selection is also model-agnostic. The injection model is not a static
   * fallback model; it is a currently eligible divergent candidate selected
   * from the enabled routing pool for the foundation chosen in Step 1.
   */
  injectionSelection: 'divergent' | 'top_rank' | 'different_tier' | number;

  /** Optional AI-mode weights. Defaults to the existing Smartest preset. */
  aiWeights?: RoutingWeights;

  /** Minimum intelligence gap required between foundation and injection models */
  minIntelligenceGap: number;  // default: 10 (composite score difference)

  /** Maximum sentence count for the injection response */
  injectionMaxSentences: number;  // default: 2

  /** Regex or heuristic for detecting meowing (gibberish, structural tag leakage, etc.) */
  meowPatterns: string[];

  /** Concurrent request threshold above which the oscillator is load-shed disabled */
  loadShedThreshold: number;  // default: 21

  /** Timeout for each oscillator step (ms) */
  stepTimeoutMs: number;  // default: 30000

  /** Fallback behavior when oscillator fails: 'foundation_only' | 'injection_only' */
  fallbackMode: 'foundation_only' | 'injection_only';
}
```

### 2.4 Context Bridge Data Model

The context bridge sanitizes inter-model handoffs. It reuses `maybeInjectContextHandoff` but adds provider-specific token stripping:

```typescript
interface ContextBridgeResult {
  /** The sanitized messages ready for the next model */
  messages: ChatMessage[];

  /** How many special tokens / artifacts were stripped */
  strippedArtifacts: number;

  /** Token budget used by the bridge injection */
  injectedTokens: number;

  /** The bridge type that was applied */
  bridgeType: 'standard_handoff' | 'oscillator_handoff' | 'none';
}

interface BridgeSanitizer {
  /** Regex patterns for provider-specific tokens to strip */
  tokenPatterns: RegExp[];
  /** Regex patterns for structural artifacts (e.g., tool_call markers) to strip */
  structuralPatterns: RegExp[];
  /** System markers that should be converted to plain text */
  systemMarkerMap: Record<string, string>;
}
```

### 2.5 Advice Application Layer

```typescript
interface AdviceResult {
  applied: 'score_boost' | 'score_penalty' 
         | 'cooldown_extend' | 'cooldown_reduce'
         | 'recheck_scheduled' | 'alt_suggested' 
         | 'oscillator_toggled' | 'injection_adjusted'  // ★ NEW
         | 'no_opinion' | 'parse_error';
  modelDbId?: number;
  magnitude: number;
}
```

---

## 3. Algorithm Details

### 3.1 `buildAdvisoryPayload()` — Updated with Oscillator Metrics

Located in `server/src/services/heartbeat-advisor.ts`.

```typescript
function buildAdvisoryPayload(platform: string, modelDbId: number, modelId: string, keyId: number): AdvisoryPayload {
  const db = getDb();
  const now = Date.now();
  const windowMs = getScoringWindowMs();
  const since = new Date(now - windowMs).toISOString();

  // 1. Key health for all keys on this provider (unchanged from v1)
  const keys = /* ... existing key health collection ... */;

  // 2. Per-model stats (unchanged from v1)
  const models = /* ... existing stats collection ... */;

  // 3. Cooldowns (unchanged from v1)
  const cooldowns = /* ... existing cooldown collection ... */;

  // 4. Daily usage (unchanged from v1)
  const dailyUsage = /* ... existing daily usage collection ... */;

  // 5. Routing info (unchanged from v1)
  const routing = { strategy: getRoutingStrategy(), customWeights: getCustomWeights() };

  // ─── ★ NEW: Oscillator metrics ─────────────────────────────
  const oscillator = collectOscillatorStats(windowMs);

  return { self: { provider: platform, model: modelId }, keys, models, cooldowns, dailyUsage, routing, oscillator };
}
```

### 3.2 Context Bridge & Sanitization

This is the core addition that enables the Rabbit Shake oscillator. It sits **between** the existing `context-handoff.ts` and the provider calls, adding **provider-specific token stripping** that the handoff module currently lacks.

```typescript
// server/src/services/context-bridge.ts

import { parseTokenDialect } from '../lib/tool-call-rescue.js';
import { maybeInjectContextHandoff, type ContextHandoffMode } from './context-handoff.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';

/** Provider-specific sanitizer definitions */
const PROVIDER_SANITIZERS: Record<string, BridgeSanitizer> = {
  openai: {
    // OpenAI models sometimes emit <|im_sep|> in raw completions
    tokenPatterns: [/<\|im_sep\|>/g, /<\|endofprompt\|>/g],
    structuralPatterns: [],
    systemMarkerMap: {},
  },
  anthropic: {
    // Anthropic may inject </reflection> or </thinking> closure tags
    tokenPatterns: [/<\/reflection>/g, /<\/thinking>/g],
    structuralPatterns: [],
    systemMarkerMap: { '</reflection>': '[End of reflection]' },
  },
  google: {
    // Gemini sometimes leaks through code execution markers
    tokenPatterns: [/<code_execution_result>/g, /<\/code_execution_result>/g],
    structuralPatterns: [],
    systemMarkerMap: {},
  },
  commandcode: {
    // CommandCode / DeepSeek Kimi dialect: <|tool_call_begin|> blocks
    tokenPatterns: [/<\|tool_call_begin\|>/g, /<\|tool_call_end\|>/g, /<\|tool_call_argument_begin\|>/g, /<\|tool_calls_section_begin\|>/g, /<\|tool_calls_section_end\|>/g],
    structuralPatterns: [/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g],
    systemMarkerMap: {},
  },
  default: {
    tokenPatterns: [],
    structuralPatterns: [],
    systemMarkerMap: {},
  },
};

/**
 * Sanitize a model response for cross-provider handoff.
 * Strips provider-specific tokens and structural artifacts,
 * then converts to clean, standardized plain text.
 */
function sanitizeForCrossProvider(
  responseText: string,
  sourceProvider: string,
): { cleanText: string; strippedCount: number } {
  const sanitizer = PROVIDER_SANITIZERS[sourceProvider] ?? PROVIDER_SANITIZERS.default;
  let clean = responseText;
  let strippedCount = 0;

  // 1. First, use parseTokenDialect for DeepSeek/Kimi tool blocks
  //    This already strips <|tool_call_begin|> blocks and extracts
  //    clean text — we reuse it rather than reimplementing.
  const dialectResult = parseTokenDialect(clean, new Set());
  if (dialectResult.calls || clean !== dialectResult.cleanText) {
    clean = dialectResult.cleanText;
    strippedCount += (clean.length - responseText.length) > 0 ? 1 : 0;
  }

  // 2. Strip structural patterns (full blocks like <|tool_call...|>)
  for (const pattern of sanitizer.structuralPatterns) {
    const matches = clean.match(pattern);
    if (matches) strippedCount += matches.length;
    clean = clean.replaceAll(new RegExp(pattern.source, pattern.flags), '');
  }

  // 3. Replace individual token markers with human-readable equivalents
  for (const pattern of sanitizer.tokenPatterns) {
    const matches = clean.match(pattern);
    if (matches) strippedCount += matches.length;
    clean = clean.replaceAll(new RegExp(pattern.source, pattern.flags), '');
  }

  // 4. Map system markers to plain text equivalents
  for (const [marker, replacement] of Object.entries(sanitizer.systemMarkerMap)) {
    if (clean.includes(marker)) {
      clean = clean.replaceAll(marker, replacement);
      strippedCount++;
    }
  }

  // 5. Final safety pass: strip any remaining <|...|> token patterns
  //    from ANY provider (catches things we didn't explicitly list)
  const genericTokenPattern = /<\|[a-z_]+\|>/g;
  const genericMatches = clean.match(genericTokenPattern);
  if (genericMatches) {
    strippedCount += genericMatches.length;
    clean = clean.replaceAll(genericTokenPattern, '');
  }

  return { cleanText: clean.trim(), strippedCount };
}

/**
 * Build a context bridge message for inter-model handoff.
 * Wraps maybeInjectContextHandoff with additional sanitizer logic.
 */
function buildContextBridge(params: {
  mode: ContextHandoffMode;
  sessionKey: string;
  messages: ChatMessage[];
  selectedModelKey: string;
  /** Source provider for sanitizer selection */
  sourceProvider: string;
  /** If true, this is an oscillator handoff (not just a sticky-session switch) */
  isOscillatorHandoff?: boolean;
  /** The prior model's response text to embed in the bridge */
  priorResponseText?: string;
}): ContextBridgeResult {
  const { mode, sessionKey, messages, selectedModelKey, sourceProvider, isOscillatorHandoff, priorResponseText } = params;

  // 1. Run the standard context handoff
  const handoff = maybeInjectContextHandoff({ mode, sessionKey, messages, selectedModelKey });
  let resultMessages = handoff.messages;
  let injectedTokens = handoff.injectedTokens;

  // 2. If this is an oscillator handoff with a prior response,
  //    sanitize the prior response and add it as context
  if (isOscillatorHandoff && priorResponseText) {
    const { cleanText, strippedCount } = sanitizeForCrossProvider(priorResponseText, sourceProvider);
    
    const injectionMsg: ChatMessage = {
      role: 'system',
      content: `[Thought Context: ${cleanText}]`,
    };

    // Insert after existing system messages
    const insertAt = resultMessages.findIndex(m => m.role !== 'system');
    const pos = insertAt === -1 ? resultMessages.length : insertAt;
    resultMessages = [...resultMessages.slice(0, pos), injectionMsg, ...resultMessages.slice(pos)];
    injectedTokens += Math.ceil(injectionMsg.content.length / 4);

    return { messages: resultMessages, strippedArtifacts: strippedCount, injectedTokens, bridgeType: 'oscillator_handoff' };
  }

  return { messages: resultMessages, strippedArtifacts: 0, injectedTokens, bridgeType: handoff.injected ? 'standard_handoff' : 'none' };
  }
  ```

  ### 3.2.1 Model Resolution Functions

  These functions use the existing routing score system to dynamically select foundation and injection models. They must not hardcode provider or model names. The foundation resolver returns an ordered candidate list so Step 1 can advance to the next eligible Smartest-weight model if the preferred model fails.

  ```typescript
  // server/src/services/rabbit-shake.ts

  import { intelligenceComposite, getRoutingScores, type ChainRow } from '../services/router.js';
  import { getDb } from '../db/index.js';

  /**
   * Resolve ordered foundation model candidates based on config selection strategy.
   * The first candidate is the preferred foundation. Later candidates are failover
   * options if the Step 1 call fails before producing usable output.
   */
  function resolveFoundationCandidates(config: OscillatorConfig): ChainRow[] {
    const scores = getRoutingScores({
      strategy: 'smartest',
      weights: config.aiWeights ?? RABBIT_AI_DEFAULT_WEIGHTS,
    });
    const eligible = scores.scores
      .filter(s => s.enabled && s.modelDbId)
      .sort((a, b) => b.compositeScore - a.compositeScore);
    if (eligible.length === 0) throw new Error('No eligible models for oscillator foundation');

    if (typeof config.foundationSelection === 'number') {
      const explicit = eligible.find(s => s.modelDbId === config.foundationSelection);
      if (explicit) return [explicit, ...eligible.filter(s => s.modelDbId !== explicit.modelDbId)];
      return eligible;
    }

    switch (config.foundationSelection) {
      case 'top_rank':
        // Prefer intelligence_rank = 1 (best), then keep all other eligible models
        // ordered by current routing score for Step 1 failover.
        const topRank = eligible.find(s => s.intelligenceRank === 1);
        if (topRank) return [topRank, ...eligible.filter(s => s.modelDbId !== topRank.modelDbId)];
        return eligible;

      case 'auto':
      default:
        // Highest Rabbit AI / Smartest-weight routing score first, then lower-ranked failovers.
        return eligible;
    }
  }

  /**
   * Resolve the injection model DB ID based on config selection strategy,
   * ensuring it's different from the foundation model and meets the intelligence gap.
   */
  function resolveInjectionModel(config: OscillatorConfig, foundationModelDbId: number): number {
    const scores = getRoutingScores();
    const allEligible = scores.scores.filter(s => s.enabled && s.modelDbId);
    const foundation = allEligible.find(s => s.modelDbId === foundationModelDbId);
    const eligible = allEligible.filter(s => s.modelDbId !== foundationModelDbId);
    if (eligible.length === 0) throw new Error('No eligible models for oscillator injection');

    const foundationComposite = foundation?.compositeScore ?? 0;

    switch (config.injectionSelection) {
      case 'divergent':
        // Prefer: different provider, high intelligence, meets min gap
        const divergent = eligible
          .filter(s => s.provider !== foundation?.provider)
          .filter(s => Math.abs(foundationComposite - s.compositeScore) >= config.minIntelligenceGap)
          .sort((a, b) => b.compositeScore - a.compositeScore)[0];
        if (divergent) return divergent.modelDbId;
        // Fallback: any different provider with high intelligence
        const diffProvider = eligible.filter(s => s.provider !== foundation?.provider)
          .sort((a, b) => b.compositeScore - a.compositeScore)[0];
        if (diffProvider) return diffProvider.modelDbId;
        // Last resort: highest intelligence regardless of provider
        return eligible.sort((a, b) => b.compositeScore - a.compositeScore)[0].modelDbId;

      case 'top_rank':
        return eligible.sort((a, b) => b.compositeScore - a.compositeScore)[0].modelDbId;

      case 'different_tier':
        const foundationTier = foundation?.sizeLabel ?? '';
        const diffTier = eligible
          .filter(s => s.sizeLabel !== foundationTier)
          .sort((a, b) => b.compositeScore - a.compositeScore)[0];
        if (diffTier) return diffTier.modelDbId;
        return eligible.sort((a, b) => b.compositeScore - a.compositeScore)[0].modelDbId;

      default:
        // Numeric override
        if (typeof config.injectionSelection === 'number') {
          const explicit = eligible.find(s => s.modelDbId === config.injectionSelection);
          if (explicit) return explicit.modelDbId;
        }
        return eligible.sort((a, b) => b.compositeScore - a.compositeScore)[0].modelDbId;
    }
  }
  ```

  ### 3.3 Rabbit Shake Oscillator — Request Pipeline

The oscillator is triggered **instead of** a normal single-model request when all conditions are met:
1. The active routing strategy is `ai` / Rabbit Shake, and oscillator execution is enabled for AI mode
2. The request is auto-routed (no pinned model)
3. The prompt is classified as "complex reasoning" (heuristic: total message length > 500 chars OR contains code blocks OR has multi-turn assistant messages)
4. Current concurrent request count is below `loadShedThreshold`

The oscillator is model-agnostic. It resolves an ordered foundation candidate list from the enabled routing pool, using Rabbit AI / Smartest weights plus health, capability, and current routing eligibility. The injection model is then selected relative to the foundation candidate, preferring a high-intelligence divergent provider or tier. If the first foundation candidate fails before Step 1 succeeds, the router should try the next foundation candidate and re-resolve the injection model for that candidate.

```typescript
// server/src/services/rabbit-shake.ts

interface OscillatorResult {
  /** Final response text */
  text: string;
  /** Whether all 3 steps completed */
  complete: boolean;
  /** Which step failed (if any) */
  failedStep?: 1 | 2 | 3;
  /** End-to-end latency */
  latencyMs: number;
  /** Meow detection result */
  meowDetected: boolean;
  /** Which model produced the final response */
  finalModelDbId: number;
  /** Context bridge stats */
  bridgeStats: ContextBridgeResult[];
}

async function executeOscillator(params: {
  messages: ChatMessage[];
  sessionKey: string;
  route: RouteResult;
  estimatedTokens: number;
}): Promise<OscillatorResult> {
  const { messages, sessionKey, route } = params;
  const config = getOscillatorConfig();
  const start = Date.now();
  const bridgeStats: ContextBridgeResult[] = [];

  // ─── Step 1: Foundation (top Rabbit AI / Smartest-weight candidate) ─
  let foundationText = '';
  let foundationProvider = '';
  let foundationModelDbId = 0;
  const foundationCandidates = resolveFoundationCandidates(config);
  for (const candidate of foundationCandidates) {
    try {
      const foundationResult = await callModelWithTimeout(
        candidate.modelDbId,
        messages,
        { max_tokens: route.maxOutputTokens },
        config.stepTimeoutMs,
      );
      foundationModelDbId = candidate.modelDbId;
      foundationText = extractResponseText(foundationResult);
      foundationProvider = getPlatformForModelDbId(foundationModelDbId);
      break;
    } catch (err) {
      recordOscillatorCandidateFailure(candidate.modelDbId, err);
    }
  }
  if (!foundationText) {
    // All foundation candidates failed → fall back to normal single-model path
    return {
      text: '', complete: false, failedStep: 1,
      latencyMs: Date.now() - start, meowDetected: false,
      finalModelDbId: 0, bridgeStats,
    };
  }

  // ─── Step 2: Injection (divergent-intelligence model) ────────
  // Sanitize Foundation's output and build a bridge context
  const injectionModelDbId = resolveInjectionModel(config, foundationModelDbId);
  const bridge1 = buildContextBridge({
    mode: 'on_model_switch',
    sessionKey,
    messages,
    selectedModelKey: getModelKey(injectionModelDbId),
    sourceProvider: foundationProvider,
    isOscillatorHandoff: true,
    priorResponseText: foundationText,
  });
  bridgeStats.push(bridge1);

  // Build injection-specific prompt with strict constraints
  const injectionMessages: ChatMessage[] = [
    ...bridge1.messages,
    {
      role: 'user',
      content: [
        'Review the reasoning in [Thought Context] above.',
        'Check for logical loops, circular reasoning, or overlooked alternatives.',
        'Provide your perspective in EXACTLY ' + config.injectionMaxSentences + ' sentences.',
        'Do not repeat the existing reasoning. Offer a genuinely different angle.',
      ].join(' '),
    },
  ];

  let injectionText: string;
  let injectionProvider: string;
  try {
    const injectionResult = await callModelWithTimeout(
      injectionModelDbId,
      injectionMessages,
      { max_tokens: 128, temperature: 0.7 },  // Higher temp for divergent reasoning
      config.stepTimeoutMs,
    );
    injectionText = extractResponseText(injectionResult);
    injectionProvider = getPlatformForModelDbId(injectionModelDbId);
  } catch (err) {
    // Step 2 fails → return Foundation's response as-is (graceful degradation)
    return {
      text: foundationText, complete: false, failedStep: 2,
      latencyMs: Date.now() - start, meowDetected: false,
      finalModelDbId: foundationModelDbId, bridgeStats,
    };
  }

  // ─── Step 3: Anchor (Foundation model synthesizes with injection) ──
  const bridge2 = buildContextBridge({
    mode: 'on_model_switch',
    sessionKey,
    messages,
    selectedModelKey: getModelKey(foundationModelDbId),
    sourceProvider: injectionProvider,
    isOscillatorHandoff: true,
    priorResponseText: injectionText,
  });
  bridgeStats.push(bridge2);

  const anchorMessages: ChatMessage[] = [
    ...bridge2.messages,
    {
      role: 'user',
      content: [
        'Your prior analysis is in [Thought Context].',
        'A different model offered this alternative perspective:',
        `"${injectionText}"`,
        'Integrate this perspective into your final response if it improves the reasoning.',
        'If the alternative is irrelevant or incorrect, proceed with your original analysis.',
      ].join(' '),
    },
  ];

  let anchorText: string;
  try {
    const anchorResult = await callModelWithTimeout(
      foundationModelDbId,
      anchorMessages,
      { max_tokens: route.maxOutputTokens },
      config.stepTimeoutMs,
    );
    anchorText = extractResponseText(anchorResult);
  } catch (err) {
    // Step 3 fails → return Foundation's response as-is
    return {
      text: foundationText, complete: false, failedStep: 3,
      latencyMs: Date.now() - start, meowDetected: false,
      finalModelDbId: foundationModelDbId, bridgeStats,
    };
  }

  // ─── Stability & Anti-Meow Validation ──────────────────────
  const meowDetected = detectMeow(anchorText, config.meowPatterns);
  
  if (meowDetected) {
    // Return Foundation's clean response instead of the corrupted synthesis
    return {
      text: foundationText,    // ← fall back to pre-oscillation output
      complete: true,          // technically complete (we have a valid response)
      latencyMs: Date.now() - start,
      meowDetected: true,
      finalModelDbId: foundationModelDbId,
      bridgeStats,
    };
  }

  return {
    text: anchorText,
    complete: true,
    latencyMs: Date.now() - start,
    meowDetected: false,
    finalModelDbId: foundationModelDbId,
    bridgeStats,
  };
}
```

### 3.4 Meow Detection ("Anti-Meow" Validation)

Detects context corruption — when the oscillator produces gibberish or structural tag leakage instead of coherent text.

```typescript
function detectMeow(text: string, patterns: string[]): boolean {
  // 1. Check configured patterns
  for (const pattern of patterns) {
    if (new RegExp(pattern).test(text)) return true;
  }

  // 2. Built-in heuristics (always active)
  
  // 2a. Raw structural tag leakage: any <|...|> tokens survived the bridge
  if (/<\|[a-z_]+\|>/i.test(text)) return true;

  // 2b. Sudden linguistic style shift mid-response
  //     e.g., coherent English → random Chinese characters → English
  //     We detect this via Unicode script fragmentation
  const scriptFragments = detectScriptFragmentation(text);
  if (scriptFragments > 3) return true;  // more than 3 script switches = suspicious

  // 2c. Model-specific system markers in output
  const SYSTEM_MARKERS = [
    '</reflection>', '</thinking>', '</thought>',
    '<|endofprompt|>', '<|im_sep|>',
    'AnimaRouter context handoff:',  // ← shouldn't appear in output!
  ];
  for (const marker of SYSTEM_MARKERS) {
    if (text.includes(marker)) return true;
  }

  // 2d. Repeated character sequences (classic "meowing" pattern)
  if (/(.)\1{10,}/.test(text)) return true;  // 11+ repeated chars

  return false;
}

/** Count the number of Unicode script transitions in a string */
function detectScriptFragmentation(text: string): number {
  const scripts: string[] = [];
  for (const char of text) {
    if (/\p{Script=Latin}/u.test(char)) scripts.push('L');
    else if (/\p{Script=Han}/u.test(char)) scripts.push('H');
    else if (/\p{Script=Cyrillic}/u.test(char)) scripts.push('C');
    else if (/\p{Script=Arabic}/u.test(char)) scripts.push('A');
    else if (/\p{Script=Hiragana}/u.test(char) || /\p{Script=Katakana}/u.test(char)) scripts.push('J');
    else if (/\s/.test(char)) continue;
    else scripts.push('O');
  }
  let switches = 0;
  for (let i = 1; i < scripts.length; i++) {
    if (scripts[i] !== scripts[i - 1] && scripts[i] !== 'O') switches++;
  }
  return switches;
}
```

### 3.5 Dynamic Load-Shedding (Traffic Throttling)

The oscillator is automatically disabled when concurrent traffic exceeds a threshold, preventing cold-start bottlenecks and cascading latency timeouts.

```typescript
// In proxy.ts request handler:
const currentInFlight = providerInFlight.get(route.platform)?.count ?? 0;
const oscillatorEligible = 
  isOscillatorEnabled() &&
  !pinnedModel &&
  isComplexReasoningRequest(messages) &&
  currentInFlight < getOscillatorLoadShedThreshold();

if (oscillatorEligible) {
  // Execute 3-step oscillator pipeline
  const result = await executeOscillator({ messages, sessionKey, route, estimatedTokens });
  
  // Log oscillator outcome for heartbeat advisor metrics
  logOscillatorResult(result);
  
  if (result.text) {
    // Return synthesized text, selected-foundation fallback, or meow-safe fallback.
    return sendResponse(result.text, result.finalModelDbId);
  }
  // If all Step 1 foundation candidates failed before any usable output,
  // fall through to normal best-eligible model routing.
}

// Normal single-model path (existing code, unchanged)
```

### 3.6 `applyAdvice()` — Updated with Oscillator Controls

```typescript
function applyAdvice(advice: RoutingAdvice, modelDbId: number, platform: string, modelId: string, keyId: number): AdviceResult {
  // Existing score/cooldown/recheck logic (unchanged from v1)
  // ...

  // ─── ★ NEW: Oscillator controls ────────────────────────────
  
  if (advice.oscillatorHint === 'enable' && !isOscillatorEnabled()) {
    // Only enable if the advisor is confident AND conditions look good
    if (advice.confidence >= 7) {
      setOscillatorEnabledOverride(true);
      return { applied: 'oscillator_toggled', magnitude: 1 };
    }
  }
  
  if (advice.oscillatorHint === 'disable' && isOscillatorEnabled()) {
    // Disable more freely — safety first
    if (advice.confidence >= 4) {
      setOscillatorEnabledOverride(false);
      return { applied: 'oscillator_toggled', magnitude: -1 };
    }
  }

  if (advice.injectionModel && advice.confidence >= 6) {
    // Suggest an alternative injection model
    const targetModelDbId = resolveModelKey(advice.injectionModel);
    if (targetModelDbId) {
      publish({
        type: 'heartbeat.advisor_applied',
        provider: platform,
        model: modelId,
        action: 'injection_adjusted',
        magnitude: targetModelDbId,
        at: Date.now(),
      });
      return { applied: 'injection_adjusted', magnitude: targetModelDbId };
    }
  }

  return { applied: 'no_opinion', magnitude: 0 };
}
```

### 3.7 Advisory System Prompt (updated)

```
You are a routing advisor for an LLM proxy. Given the operational data below, 
return a compact routing suggestion as JSON or colon-separated:
{c:confidence_0-9,s:self_score_-9_to_9,a:alt_provider:model,h:cooldown_hint_0-2,r:recheck_0_or_1,o:oscillator_hint_e_d_n,i:injection_model,b:brevity_s_l_d}

Or compact: confidence:selfScore:altModel:cooldownHint:recheck:oscillator:injectionModel:brevity

Field guide:
  o: e=enable_oscillator, d=disable_oscillator, n=no_opinion
  i: provider:model for suggested injection model (empty=keep current)
  b: s=shorter_injection, l=longer_injection, d=default

Only advise on what the data supports. Return {c:0,s:0,h:0,r:0,o:n,i:,b:d} if uncertain.

<operational-data>
${JSON.stringify(payload)}
</operational-data>
```

### 3.8 Fallback Behavior (unchanged from v1)

If the advisor is disabled or the response can't be parsed:
1. The ping still succeeds or fails based on HTTP status → binary health check
2. No adjustments are applied
3. The system behaves identically to the current heartbeat

---

## 4. Configuration

### 4.1 Heartbeat Advisor Settings (from v1, unchanged)

```typescript
{
  key: 'heartbeat_advisor_enabled',
  label: 'AI Routing Advisor',
  description: 'Send operational telemetry in heartbeat pings and parse AI routing advice from the response.',
  type: 'boolean', default: false,
  envVar: 'HEARTBEAT_ADVISOR_ENABLED', effect: 'restart', group: 'Resilience',
},
{
  key: 'heartbeat_advisor_max_input_tokens',
  label: 'Advisor Input Token Budget',
  description: 'Maximum advisory payload size in tokens.',
  type: 'number', default: 400, min: 100, max: 2000,
  envVar: 'HEARTBEAT_ADVISOR_MAX_INPUT_TOKENS', effect: 'restart', group: 'Resilience',
},
{
  key: 'heartbeat_advisor_max_output_tokens',
  label: 'Advisor Output Token Budget',
  description: 'Maximum response tokens for the advisory response. 8–10 recommended for reliable parsing.',
  type: 'number', default: 10, min: 5, max: 32,
  envVar: 'HEARTBEAT_ADVISOR_MAX_OUTPUT_TOKENS', effect: 'restart', group: 'Resilience',
},
```

### 4.2 Rabbit Shake AI Routing Settings (NEW)

```typescript
{
  key: 'routing_strategy',
  label: 'Routing Strategy',
  description: 'Add "ai" / Rabbit Shake as a selectable strategy. AI mode uses Smartest weights for normal routing and enters the 3-step oscillator for eligible complex reasoning prompts.',
  type: 'string',
  enum: ['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom', 'ai'],
  default: 'balanced',
  envVar: 'ROUTING_STRATEGY', effect: 'live', group: 'Routing',
},
{
  key: 'rabbit_ai_enabled',
  label: 'Rabbit Shake AI Mode',
  description: 'Enable the Rabbit Shake AI routing strategy. AI mode uses Smartest-weight model ordering, then runs the 3-step multi-model oscillator for eligible complex reasoning prompts.',
  type: 'boolean', default: false,
  envVar: 'RABBIT_AI_ENABLED', effect: 'live', group: 'Routing',
},
{
  key: 'rabbit_ai_weights',
  label: 'Rabbit AI Weights',
  description: 'Optional AI-mode weight override. Defaults to Smartest: intelligence 45%, reliability 30%, latency 15%, speed 10%.',
  type: 'json', default: null,
  envVar: 'RABBIT_AI_WEIGHTS', effect: 'live', group: 'Routing',
},
{
  key: 'oscillator_foundation_selection',
  label: 'Oscillator Foundation Selection',
  description: 'How to select foundation candidates (Steps 1 & 3). \'auto\' = ordered by Rabbit AI / Smartest-weight score; \'top_rank\' = intelligence_rank=1 first; or explicit model DB ID. If the first candidate fails Step 1, try the next eligible candidate.',
  type: 'string', default: 'auto',
  enum: ['auto', 'top_rank'],
  envVar: 'OSCILLATOR_FOUNDATION_SELECTION', effect: 'restart', group: 'Resilience',
},
{
  key: 'oscillator_injection_selection',
  label: 'Oscillator Injection Selection',
  description: 'How to select the injection model (Step 2). \'divergent\' = high intelligence, different provider from the selected foundation; \'top_rank\' = highest eligible non-foundation model; \'different_tier\' = different size tier; or explicit model DB ID.',
  type: 'string', default: 'divergent',
  enum: ['divergent', 'top_rank', 'different_tier'],
  envVar: 'OSCILLATOR_INJECTION_SELECTION', effect: 'restart', group: 'Resilience',
},
{
  key: 'oscillator_min_intelligence_gap',
  label: 'Minimum Intelligence Gap',
  description: 'Minimum intelligence composite score difference required between foundation and injection models. Prevents picking nearly-identical models for injection.',
  type: 'number', default: 10, min: 0, max: 1000,
  envVar: 'OSCILLATOR_MIN_INTELLIGENCE_GAP', effect: 'live', group: 'Resilience',
},
{
  key: 'oscillator_injection_max_sentences',
  label: 'Injection Max Sentences',
  description: 'Maximum sentences the injection model may return. Keeps the divergent perspective concise to avoid token collisions.',
  type: 'number', default: 2, min: 1, max: 5,
  envVar: 'OSCILLATOR_INJECTION_MAX_SENTENCES', effect: 'live', group: 'Resilience',
},
{
  key: 'oscillator_load_shed_threshold',
  label: 'Load-Shed Threshold',
  description: 'Concurrent request count above which the oscillator is bypassed and traffic uses normal best-eligible single-model routing. Default: 21. Eligibility resumes automatically when traffic drops below the threshold.',
  type: 'number', default: 21, min: 5, max: 100,
  envVar: 'OSCILLATOR_LOAD_SHED_THRESHOLD', effect: 'live', group: 'Resilience',
},
{
  key: 'oscillator_step_timeout_ms',
  label: 'Step Timeout (ms)',
  description: 'Timeout per oscillator step. If any step exceeds this, the oscillator falls back to the foundation model\'s response.',
  type: 'number', default: 30000, min: 5000, max: 120000,
  envVar: 'OSCILLATOR_STEP_TIMEOUT_MS', effect: 'live', group: 'Resilience',
},
```

---

## 5. Cost Analysis

### 5.1 Heartbeat Advisor (unchanged from v1)

Per-ping cost delta: ~$0.00002–0.00017 depending on provider. Typical setup: ~$0.02–0.10/day.

### 5.2 Rabbit Shake Oscillator (NEW)

The oscillator triples the token cost for eligible requests (3 API calls instead of 1), but:

| Factor | Analysis |
|---|---|
| Eligibility rate | Only "complex reasoning" auto-routed requests (~10–20% of traffic) |
| Step 1 cost | Normal routing cost (same as today) |
| Step 2 cost | Low: small output (≤128 tokens), high temp |
| Step 3 cost | Medium: full-size output + prior context |
| Meow fallback | Returns Step 1 output → no wasted re-request |
| Load shedding | Disabled under high load → zero extra cost during peaks |
| **Net cost increase** | **~2.3× for ~15% of traffic → ~1.3× overall** |

---

## 6. Privacy & Security

### What the payload DOES include
- Numeric key IDs (not secrets)
- Model names/slugs
- Aggregate success rates, latencies, error categories
- Degradation tier labels
- Cooldown escalation levels
- Routing strategy name
- Oscillator attempt/success/failure counts
- Meow detection counts

### What the payload DOES NOT include
- Raw API keys or auth tokens
- User prompts or conversation content
- IP addresses or user identifiers
- Raw error messages with internal details

### Oscillator-Specific Privacy
- The `[Thought Context: ...]` bridge message contains **only the prior model's response text** — never the user's original prompt (that's already in the message history).
- Injection model receives sanitized, stripped text — no provider-specific tokens or structural artifacts.
- Meow detection logs only a boolean flag and matched pattern name, never the corrupted text.

### Sanitization Rules (unchanged from v1, plus cross-provider)
1. `lastError` fields: truncated to 80 chars, stripped of URL/path/UUID
2. No request IDs or session keys in payload
3. Provider-internal error codes mapped to categories
4. **NEW**: All `[Thought Context]` blocks pass through `sanitizeForCrossProvider` to strip provider-specific tokens

---

## 7. Event System Integration

### 7.1 Advisory Events (from v1)

```typescript
| { type: 'heartbeat.advisor_parsed'; provider: string; model: string; keyId: number; advice: RoutingAdvice; at: number }
| { type: 'heartbeat.advisor_failed'; provider: string; model: string; keyId: number; reason: string; at: number }
| { type: 'heartbeat.advisor_applied'; provider: string; model: string; action: AdviceResult['applied']; magnitude: number; at: number }
```

### 7.2 Oscillator Events (NEW)

```typescript
| { type: 'oscillator.started'; sessionKey: string; foundationModel: string; injectionModel: string; at: number }
| { type: 'oscillator.step_complete'; sessionKey: string; step: 1 | 2 | 3; model: string; latencyMs: number; bridgeType: string; strippedArtifacts: number; at: number }
| { type: 'oscillator.complete'; sessionKey: string; totalLatencyMs: number; meowDetected: boolean; finalModel: string; at: number }
| { type: 'oscillator.failed'; sessionKey: string; failedStep: 1 | 2 | 3; error: string; fellBackTo: string; at: number }
| { type: 'oscillator.load_shed'; concurrentRequests: number; threshold: number; at: number }
| { type: 'oscillator.meow_detected'; sessionKey: string; pattern: string; fellBackTo: string; at: number }
```

---

## 8. Testing Strategy

| Layer | What to test |
|---|---|
| `buildAdvisoryPayload` | Correct aggregation, no secret leakage, payload size |
| Advisory prompt | Well-formed, system + user messages |
| Response parsing | JSON, compact format, malformed → graceful fallback |
| `applyAdvice` | Score boost/penalty caps, cooldown factors, Rabbit AI mode / oscillator controls |
| **`sanitizeForCrossProvider`** | **Each provider's token patterns, structural block removal, generic `<\|...\|>` fallback** |
| **`buildContextBridge`** | **Standard handoff path, oscillator handoff with [Thought Context], no artifact leakage** |
| `detectMeow` | Structural tag leakage, script fragmentation, repeated chars, false positives on normal text |
| **`executeOscillator`** | **Happy path (3 steps complete), Step 1 candidate failure → next candidate, all Step 1 candidates fail → normal path, Step 2 timeout → selected-foundation fallback, Step 3 meow → selected-foundation fallback** |
| **Load shedding** | **Threshold enforcement, automatic re-enable below threshold** |
| Integration | Advisor enabled → parsed → applied; oscillator enabled → 3-step → events published |

---

## 9. Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Model returns garbage / ignores advisory format | High (early) | Low | Strict parsing + `c:0` sentinel = no-op |
| Advisory creates feedback loops | Medium | Medium | Ephemeral per-cycle; past adjustments absorbed into stats |
| **Oscillator Step 2 (injection) amplifies bias instead of diversifying** | Medium | Medium | Higher temperature (0.7) + strict 2-sentence limit; meow validation catches incoherence |
| **Cross-provider token leakage ("meowing")** | Medium | High | `sanitizeForCrossProvider` strips all known provider tokens; generic `<\|...\|>` regex catches unknowns; meow validation as safety net |
| **Cascading latency timeouts under load** | Medium | High | Load-shed threshold bypasses oscillator; per-step timeout; Step 1 tries the next foundation candidate, Step 2/3 failures fall back to the selected foundation response |
| **Oscillator cost exceeds value** | Low | Medium | Only eligible for complex reasoning; load-shed disables under pressure; heartbeat advisor can suggest disabling if metrics are poor |
| **`parseTokenDialect` doesn't cover all provider dialects** | Low | Low | Generic `<\|...\|>` regex as second pass; meow detection catches remaining artifacts |
| **Injection model sees too much context → hallucination** | Low | Medium | Only `[Thought Context]` is passed (sanitized, not raw); 2-sentence limit; explicit prompt to provide *alternative*, not *continuation* |

---

## 10. Analytics Data Sources

*(§9 sections are unchanged from the previously expanded v1 — they document `buildAdvisoryPayload`'s concrete SQL queries, in-process source functions, and gap analysis. The oscillator metrics feed into the same payload via the new `oscillator` field, sourced from a new `oscillator_results` SQLite table.)*

### 10.1 New Table: `oscillator_results`

```sql
CREATE TABLE IF NOT EXISTS oscillator_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  foundation_model_db_id INTEGER NOT NULL,
  injection_model_db_id INTEGER NOT NULL,
  step1_latency_ms INTEGER,
  step2_latency_ms INTEGER,
  step3_latency_ms INTEGER,
  total_latency_ms INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,      -- 1 = all 3 steps succeeded
  failed_step INTEGER,                       -- 1, 2, or 3 if failed
  meow_detected INTEGER NOT NULL DEFAULT 0, -- 1 = meow triggered fallback
  stripped_artifacts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 10.2 Oscillator Stats Collection for Advisory Payload

```typescript
function collectOscillatorStats(windowMs: number): AdvisoryPayload['oscillator'] {
  const db = getDb();
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db.prepare(`
    SELECT 
      COUNT(*) AS attempts,
      SUM(CASE WHEN complete = 1 THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN complete = 0 THEN 1 ELSE 0 END) AS failures,
      AVG(CASE WHEN complete = 1 THEN total_latency_ms ELSE NULL END) AS avg_latency_ms,
      SUM(meow_detected) AS meow_count
    FROM oscillator_results
    WHERE created_at >= ?
  `).get(since) as any;

  return {
    attempts: row?.attempts ?? 0,
    successes: row?.successes ?? 0,
    failures: row?.failures ?? 0,
    avgLatencyMs: row?.avg_latency_ms ?? 0,
    meowCount: row?.meow_count ?? 0,
    loadShedActive: getCurrentConcurrent() >= getOscillatorLoadShedThreshold(),
  };
}
```
