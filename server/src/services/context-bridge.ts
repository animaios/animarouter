import type { ChatMessage } from "@animarouter/shared/types.js";
import { contentToString } from "../lib/content.js";
import { rescueInlineToolCalls } from "../lib/tool-call-rescue.js";
import {
  type ContextHandoffMode,
  maybeInjectContextHandoff,
} from "./context-handoff.js";

export interface BridgeSanitizer {
  tokenPatterns: RegExp[];
  structuralPatterns: RegExp[];
  systemMarkerMap: Record<string, string>;
}

/**
 * Streaming-compatible context bridge interface.
 * For streaming: accumulate chunks, emit bridge when step completes.
 * For non-streaming: use buildContextBridge() directly.
 */
export interface StreamingContextBridge {
  /**
   * Called when foundation step completes (full text accumulated).
   * Returns the injection prompt with sanitized foundation context.
   */
  onFoundationComplete(fullText: string): string;

  /**
   * Called when injection step completes (full text accumulated).
   * Returns the anchor prompt with sanitized injection context.
   */
  onInjectionComplete(fullText: string): string;

  /**
   * Non-streaming variant: builds the complete bridge in one call.
   * Preserves existing API for non-streaming use cases.
   */
  buildContextBridge(
    previousResponse: string,
    mode: "injection" | "anchor",
  ): string;
}

export interface ContextBridgeResult {
  messages: ChatMessage[];
  strippedArtifacts: number;
  injectedTokens: number;
  bridgeType: "standard_handoff" | "oscillator_handoff" | "none";
  cleanText?: string;
}

const MAX_THOUGHT_CONTEXT_CHARS = 6000;

const DEFAULT_TOKEN_PATTERNS = [
  /<\|[^>\n]{1,80}\|>/g,
  /\[(?:INST|\/INST|SYS|\/SYS|SYSTEM|ASSISTANT|USER)\]/gi,
  /<\/?(?:system|assistant|user|thinking|reflection)>/gi,
  /<<\/?SYS>>/g,
];

const TOOL_STRUCTURAL_PATTERNS = [
  /<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g,
  /<tool_call>[\s\S]*?<\/tool_call>/g,
  /<function=[\s\S]*?<\/function>/g,
];

export const PROVIDER_SANITIZERS: Record<string, BridgeSanitizer> = {
  openai: {
    tokenPatterns: [
      /<\|im_start\|>/g,
      /<\|im_end\|>/g,
      /<\|im_sep\|>/g,
      /<\|endofprompt\|>/g,
    ],
    structuralPatterns: [],
    systemMarkerMap: {},
  },
  anthropic: {
    tokenPatterns: [/<\/?reflection>/g, /<\/?thinking>/g],
    structuralPatterns: [],
    systemMarkerMap: {
      "</reflection>": "[End of reflection]",
      "</thinking>": "[End of thinking]",
    },
  },
  google: {
    tokenPatterns: [/<\/?code_execution_result>/g, /<\/?executable_code>/g],
    structuralPatterns: [],
    systemMarkerMap: {},
  },
  commandcode: {
    tokenPatterns: [
      /<\|tool_calls_section_begin\|>/g,
      /<\|tool_calls_section_end\|>/g,
      /<\|tool_call_begin\|>/g,
      /<\|tool_call_argument_begin\|>/g,
      /<\|tool_call_end\|>/g,
    ],
    structuralPatterns: TOOL_STRUCTURAL_PATTERNS,
    systemMarkerMap: {},
  },
  groq: {
    tokenPatterns: [/<\/?tool_call>/g, /<\/?function[^>]*>/g],
    structuralPatterns: TOOL_STRUCTURAL_PATTERNS,
    systemMarkerMap: {},
  },
  openrouter: {
    tokenPatterns: DEFAULT_TOKEN_PATTERNS,
    structuralPatterns: TOOL_STRUCTURAL_PATTERNS,
    systemMarkerMap: {},
  },
  opencode: {
    tokenPatterns: DEFAULT_TOKEN_PATTERNS,
    structuralPatterns: TOOL_STRUCTURAL_PATTERNS,
    systemMarkerMap: {},
  },
  default: {
    tokenPatterns: DEFAULT_TOKEN_PATTERNS,
    structuralPatterns: TOOL_STRUCTURAL_PATTERNS,
    systemMarkerMap: {
      "<|system|>": "[System Context]",
      "<|assistant|>": "[Assistant Context]",
      "<|user|>": "[User Context]",
      "<<SYS>>": "[System Context]",
      "<</SYS>>": "[/System Context]",
    },
  },
};

function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  const truncationSuffix = "\n...[truncated]";
  if (max <= truncationSuffix.length) return truncationSuffix.slice(0, max);
  const targetMax = Math.max(0, max - truncationSuffix.length);
  const lastCode = text.charCodeAt(targetMax - 1);
  const end =
    lastCode >= 0xd800 && lastCode <= 0xdbff ? targetMax - 1 : targetMax;
  return `${text.slice(0, end).trimEnd()}${truncationSuffix}`;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cloneGlobal(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function replacePattern(
  text: string,
  pattern: RegExp,
  replacement: string,
): { text: string; count: number } {
  let count = 0;
  const regex = pattern.global ? pattern : cloneGlobal(pattern);
  const next = text.replace(regex, () => {
    count++;
    return replacement;
  });
  return { text: next, count };
}

function contentStartsWith(message: ChatMessage, prefix: string): boolean {
  return contentToString(message.content).trimStart().startsWith(prefix);
}

/**
 * Core sanitization logic shared by both streaming and non-streaming paths.
 */
function sanitizeCore(
  responseText: string | null | undefined,
  sourceProvider?: string | null,
): { cleanText: string; strippedCount: number } {
  const providerKey = (sourceProvider ?? "default").toLowerCase();
  const sanitizer =
    PROVIDER_SANITIZERS[providerKey] ?? PROVIDER_SANITIZERS.default;
  let clean = responseText ?? "";
  let strippedCount = 0;

  const rescued = rescueInlineToolCalls(clean, new Set());
  if (rescued.detected && rescued.cleanText !== clean) {
    clean = rescued.cleanText;
    strippedCount++;
  }

  for (const pattern of sanitizer.structuralPatterns) {
    const result = replacePattern(clean, pattern, "");
    clean = result.text;
    strippedCount += result.count;
  }

  for (const [marker, replacement] of Object.entries(
    sanitizer.systemMarkerMap,
  )) {
    if (clean.includes(marker)) {
      clean = clean.replaceAll(marker, replacement);
      strippedCount++;
    }
  }

  for (const pattern of sanitizer.tokenPatterns) {
    const result = replacePattern(clean, pattern, "");
    clean = result.text;
    strippedCount += result.count;
  }

  if (sanitizer.tokenPatterns !== DEFAULT_TOKEN_PATTERNS) {
    for (const pattern of DEFAULT_TOKEN_PATTERNS) {
      const result = replacePattern(clean, pattern, "");
      clean = result.text;
      strippedCount += result.count;
    }
  }

  return {
    cleanText: safeSlice(normalizeWhitespace(clean), MAX_THOUGHT_CONTEXT_CHARS),
    strippedCount,
  };
}

/**
 * Pure sanitization function for bridge context.
 * Exposed for testing — runs on full accumulated text at step boundary.
 * No partial sanitization — waits for step complete.
 */
export function sanitizeForBridge(
  text: string,
  sourceProvider?: string | null,
): { cleanText: string; strippedCount: number } {
  return sanitizeCore(text, sourceProvider);
}

/**
 * Sanitize a model response before another provider sees it.
 * The output is plain text suitable for wrapping in a `[Thought Context: ...]` block.
 * Delegates to sanitizeCore internally.
 */
export function sanitizeForCrossProvider(
  responseText: string | null | undefined,
  sourceProvider?: string | null,
): { cleanText: string; strippedCount: number } {
  return sanitizeCore(responseText, sourceProvider);
}

/**
 * Build a thought-context injection string from sanitized text.
 * Shared by both streaming and non-streaming paths.
 */
function buildThoughtContext(cleanText: string): string {
  return `[Thought Context: ${cleanText}]`;
}

export function buildContextBridge(params: {
  mode: ContextHandoffMode;
  sessionKey: string;
  messages: ChatMessage[];
  selectedModelKey: string;
  sourceProvider: string;
  isOscillatorHandoff?: boolean;
  priorResponseText?: string | null;
}): ContextBridgeResult {
  const {
    mode,
    sessionKey,
    messages,
    selectedModelKey,
    sourceProvider,
    isOscillatorHandoff = false,
    priorResponseText,
  } = params;

  const handoff = maybeInjectContextHandoff({
    mode,
    sessionKey,
    messages,
    selectedModelKey,
  });

  let resultMessages = handoff.messages;
  let injectedTokens = handoff.injectedTokens;

  if (!isOscillatorHandoff || !priorResponseText?.trim()) {
    return {
      messages: resultMessages,
      strippedArtifacts: 0,
      injectedTokens,
      bridgeType: handoff.injected ? "standard_handoff" : "none",
    };
  }

  const existingThoughtContext = resultMessages.some(
    (message) =>
      message.role === "system" &&
      contentStartsWith(message, "[Thought Context:"),
  );
  if (existingThoughtContext) {
    return {
      messages: resultMessages,
      strippedArtifacts: 0,
      injectedTokens,
      bridgeType: handoff.injected ? "standard_handoff" : "none",
    };
  }

  const { cleanText, strippedCount } = sanitizeForCrossProvider(
    priorResponseText,
    sourceProvider,
  );
  if (!cleanText) {
    return {
      messages: resultMessages,
      strippedArtifacts: strippedCount,
      injectedTokens,
      bridgeType: handoff.injected ? "standard_handoff" : "none",
      cleanText,
    };
  }

  const thoughtContent = buildThoughtContext(cleanText);
  const thoughtMessage: ChatMessage = {
    role: "system",
    content: thoughtContent,
  };
  const insertAt = resultMessages.findIndex(
    (message) => message.role !== "system",
  );
  const pos = insertAt === -1 ? resultMessages.length : insertAt;
  resultMessages = [
    ...resultMessages.slice(0, pos),
    thoughtMessage,
    ...resultMessages.slice(pos),
  ];
  injectedTokens += Math.ceil(thoughtContent.length / 4);

  return {
    messages: resultMessages,
    strippedArtifacts: strippedCount,
    injectedTokens,
    bridgeType: "oscillator_handoff",
    cleanText,
  };
}


/**
 * Creates a streaming-compatible context bridge.
 * The bridge is a step-boundary transform, not a streaming transform.
 * Streaming executor accumulates → calls bridge at step end → passes bridge output to next step.
 *
 * Usage:
 *   const bridge = createStreamingContextBridge({ ... });
 *
 *   // Streaming flow:
 *   // 1. Accumulate foundation chunks into full text
 *   // 2. On foundation complete:
 *   const injectionPrompt = bridge.onFoundationComplete(foundationFullText);
 *   // 3. Accumulate injection chunks into full text
 *   // 4. On injection complete:
 *   const anchorPrompt = bridge.onInjectionComplete(injectionFullText);
 *
 *   // Non-streaming fallback:
 *   const prompt = bridge.buildContextBridge(previousResponse, 'injection');
 */
export function createStreamingContextBridge(params: {
  foundationProvider: string;
  injectionProvider: string;
}): StreamingContextBridge {
  const { foundationProvider, injectionProvider } = params;

  /**
   * Called when foundation step completes (full text accumulated).
   * Sanitizes the full foundation text and returns the injection prompt
   * wrapping it in [Thought Context: ...].
   */
  function onFoundationComplete(fullText: string): string {
    const { cleanText } = sanitizeForBridge(fullText, foundationProvider);
    if (!cleanText) {
      return "";
    }
    return buildThoughtContext(cleanText);
  }

  /**
   * Called when injection step completes (full text accumulated).
   * Sanitizes the full injection text and returns the anchor prompt
   * wrapping it in [Thought Context: ...].
   */
  function onInjectionComplete(fullText: string): string {
    const { cleanText } = sanitizeForBridge(fullText, injectionProvider);
    if (!cleanText) {
      return "";
    }
    return buildThoughtContext(cleanText);
  }

  /**
   * Non-streaming variant: builds the complete bridge in one call.
   * Preserves existing API for non-streaming use cases.
   */
  function buildContextBridgeNonStreaming(
    previousResponse: string,
    mode: "injection" | "anchor",
  ): string {
    const provider = mode === "injection" ? foundationProvider : injectionProvider;
    const { cleanText } = sanitizeForBridge(previousResponse, provider);
    if (!cleanText) {
      return "";
    }
    return buildThoughtContext(cleanText);
  }

  return {
    onFoundationComplete,
    onInjectionComplete,
    buildContextBridge: buildContextBridgeNonStreaming,
  };
}
