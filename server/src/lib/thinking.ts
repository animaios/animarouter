// Per-provider translation of the unified `thinking` / `reasoning_effort`
// request knobs into the wire shapes each provider actually accepts. The
// proxy layer calls through these helpers so the per-provider code only deals
// with their native vocabulary.
//
// Vocabulary summary:
//
//   Anthropic  ─  top-level `thinking: { type, budget_tokens, display }`
//                 plus `output_config: { effort }` (Opus 4.6+, Sonnet 4.6+).
//                 `type: 'adaptive'` requires `output_config.effort`.
//                 Replay path: assistant turns with extended thinking must
//                 include a thinking block with the original `signature`.
//
//   Google     ─  `generationConfig.thinkingConfig: { thinkingBudget,
//                 thinkingLevel, includeThoughts }`. Gemini 3 series uses
//                 `thinkingLevel`; 2.5 series uses `thinkingBudget`.
//
//   OpenAI-    ─  `reasoning_effort: 'low'|'medium'|'high'|'xhigh'|'max'` as
//   compat       a top-level field on the chat-completions body. Some compat
//                 providers also accept a richer `thinking` object; we pass
//                 both through unchanged when present so model-layer matching
//                 decides.
//
// Anything a provider doesn't recognize is dropped. The proxy never invents
// shape names — it maps every request knob down to a wire field that
// documentation confirms the provider accepts. (#290)

import type {
  ThinkingConfig,
  ThinkingEffort,
} from "@animarouter/shared/types.js";

// ─── Combined request view ────────────────────────────────────────────────

export interface ThinkingRequest {
  // Effective effort, merging `reasoning_effort` and `thinking.effort`.
  effort?: ThinkingEffort;
  // Whether thinking should be turned on. False means "leave default".
  enabled?: boolean;
  // 'adaptive' is Anthropic-specific. Other providers fall back to enabled.
  adaptive?: boolean;
  // Token budget (Anthropic budget_tokens / Gemini 2.5 thinkingBudget).
  budget?: number;
  // Anthropic display hint.
  display?: "summarized" | "omitted";
  // Whether the response should include the raw reasoning trace alongside the
  // summarized text. Anthropic: always true for 'summarized' display. Gemini:
  // true iff `includeThoughts` is unset or true. OpenAI-compat: ignored
  // (the upstream decides).
  includeThoughts?: boolean;
}

/** Combine the two surfaces (`reasoning_effort`, `thinking`) into a single view
 * the per-provider helpers operate on. `reasoning_effort` is just a shorter
 * alias for `thinking.effort`; `thinking.effort` overrides when both are set. */
export function normalizeThinking(opts: {
  reasoning_effort?: ThinkingEffort;
  thinking?: ThinkingConfig;
}): ThinkingRequest | undefined {
  const effort = opts.thinking?.effort ?? opts.reasoning_effort;
  if (!opts.thinking && !opts.reasoning_effort) return undefined;

  const out: ThinkingRequest = {};
  if (effort) out.effort = effort;

  const t = opts.thinking;
  if (t) {
    // mode flags
    if (t.type === "enabled") {
      out.enabled = true;
    } else if (t.type === "adaptive") {
      out.adaptive = true;
      out.enabled = true; // adaptive implies on
    } else if (t.type === "disabled") {
      out.enabled = false;
    } else if (effort) {
      // No explicit type but effort was given: turn thinking on by default so
      // the effort level has something to act on. Providers that don't tie
      // effort to thinking (Anthropic with budget, plain OpenAI-compat) drop
      // the implicit-enable without surprising the caller.
      out.enabled = true;
    }
    if (t.budget !== undefined) out.budget = t.budget;
    if (t.display !== undefined) out.display = t.display;
    if (t.includeThoughts !== undefined)
      out.includeThoughts = t.includeThoughts;
  } else if (effort) {
    out.enabled = true; // `reasoning_effort` alone is treated as enable.
  }

  return out;
}

// ─── Anthropic ────────────────────────────────────────────────────────────

/** Anthropic-side: emit the wire `thinking` object (and optionally
 * `output_config.effort`). Cards on the table:
 *  - Opus 4.7/4.8 don't accept manual `enabled`; always adaptive.
 *  - Opus 4.6 / Sonnet 4.6 still take enabled but adaptive is recommended.
 *  - effort requires `output_config.effort` on supported models.
 *
 * We don't know which Anthropic model we're talking to at the provider layer —
 * the choice between `enabled` and `adaptive` is left to the caller; the
 * proxy decides based on the model id from the catalog, when available. */
export function anthropicThinking(normalized: ThinkingRequest | undefined): {
  thinking?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
} {
  if (!normalized) return {};
  const out: {
    thinking?: Record<string, unknown>;
    output_config?: Record<string, unknown>;
  } = {};

  if (normalized.enabled === false) {
    return { thinking: { type: "disabled" } };
  }

  if (normalized.adaptive) {
    out.thinking = { type: "adaptive" };
  } else if (normalized.enabled === true) {
    const t: Record<string, unknown> = { type: "enabled" };
    if (normalized.budget !== undefined) t.budget_tokens = normalized.budget;
    if (normalized.display) t.display = normalized.display;
    out.thinking = t;
  }
  // effort: valid alongside both adaptive and enabled on supported models.
  if (normalized.effort) {
    out.output_config = { effort: normalized.effort };
  }
  return out;
}

// ─── Google Gemini ────────────────────────────────────────────────────────

// Map an effort level to a Gemini thinkingLevel (string) or thinkingBudget
// (integer). Gemini 3 series reads `thinkingLevel`; 2.5 series reads
// `thinkingBudget`. The `'minimal'` effort only applies to series that
// accept it (Gemini 3); we therefore never index with `minimal` — the
// translation pre-checks the value. (#290)
type GeminiEffort = Exclude<ThinkingEffort, "minimal">;
const GEMINI_3_LEVEL: Record<GeminiEffort, string> = {
  max: "high",
  xhigh: "high",
  high: "high",
  medium: "medium",
  low: "low",
};
const GEMINI_BUDGET: Record<GeminiEffort, number> = {
  max: 24576,
  xhigh: 24576,
  high: 16384,
  medium: 8192,
  low: 2048,
};
export function geminiThinkingConfig(
  normalized: ThinkingRequest | undefined,
  modelId: string,
): Record<string, unknown> | undefined {
  if (!normalized) return undefined;
  // enabled === false: skip the block entirely; the upstream default is
  // "thinking on" for 2.5 Pro / Flash, but emit-disable is honored by sending
  // thinkingBudget = 0 on series that support it (2.5).
  if (normalized.enabled === false) {
    const isG3 = /gemini[-_]?3/i.test(modelId);
    if (!isG3) return { thinkingBudget: 0 };
    return { thinkingLevel: "minimal" };
  }
  if (!normalized.enabled) {
    // bail with no block — model picks its own default.
    return undefined;
  }

  const isG3 = /gemini[-_]?3/i.test(modelId);
  const includeThoughts = normalized.includeThoughts ?? true;
  const cfg: Record<string, unknown> = { includeThoughts };

  // Gemini 3 series uses `thinkingLevel` (high/medium/low/minimal); 2.5
  // series uses `thinkingBudget` (an integer). Branch on the resolved effort
  // first — explicit budget always wins, otherwise the chosen series'
  // native envelope carries the effort. #290
  if (isG3) {
    if (normalized.effort === "minimal") {
      cfg.thinkingLevel = "minimal";
    } else if (normalized.effort) {
      cfg.thinkingLevel = GEMINI_3_LEVEL[normalized.effort];
    } else if (normalized.budget !== undefined) {
      cfg.thinkingBudget = normalized.budget;
    }
  } else {
    // 2.5 path (also default — older Gemini series fall through here).
    if (normalized.budget !== undefined) {
      cfg.thinkingBudget = normalized.budget;
    } else if (normalized.effort) {
      // `minimal` was already filtered into the 2.5 disable path above;
      // remaining values are bounded by GeminiEffort.
      cfg.thinkingBudget = GEMINI_BUDGET[normalized.effort as GeminiEffort];
    }
  }
  return cfg;
}

// ─── OpenAI-compat ────────────────────────────────────────────────────────

/** OpenAI-compat helpers. Providers that accept `reasoning_effort` (the
 * DeepSeek/Z.ai/Ollama-style wrapper APIs through `OpenAICompatProvider`)
 * route the string through unchanged. The richer `thinking` object reaches
 * upstream verbatim too — some providers surface it differently, but we
 * never know which at the request layer, so the simplest legal move is to
 * pass it through. */
/**
 * Decide whether `reasoning_effort` should be emitted alongside `thinking`.
 *
 * Some providers reject the pair together; we pick the dominant field per the
 * convenience rule in the comment above. If both are present, prefer the
 * explicit `thinking` object and drop `reasoning_effort` (to avoid duplicate
 * semantics), but if only `reasoning_effort` is set, emit that.
 */
export function openaiCompatThinkingBody(
  normalized: ThinkingRequest | undefined,
  original:
    | {
        reasoning_effort?: ThinkingEffort;
        thinking?: ThinkingConfig;
      }
    | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!normalized) return out;
  // If the caller passed an explicit `thinking` object, forward it unmodified.
  // Otherwise emit `reasoning_effort` only.
  if (original?.thinking) {
    out.thinking = original.thinking;
  } else if (original?.reasoning_effort) {
    out.reasoning_effort = original.reasoning_effort;
  }
  return out;
}
