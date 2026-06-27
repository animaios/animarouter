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
  const lastCode = text.charCodeAt(max - 1);
  const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end).trimEnd()}\n...[truncated]`;
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
  const next = text.replace(cloneGlobal(pattern), () => {
    count++;
    return replacement;
  });
  return { text: next, count };
}

function contentStartsWith(message: ChatMessage, prefix: string): boolean {
  return contentToString(message.content).trimStart().startsWith(prefix);
}

/**
 * Sanitize a model response before another provider sees it.
 * The output is plain text suitable for wrapping in a `[Thought Context: ...]` block.
 */
export function sanitizeForCrossProvider(
  responseText: string | null | undefined,
  sourceProvider = "default",
): { cleanText: string; strippedCount: number } {
  const providerKey = sourceProvider.toLowerCase();
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

  for (const pattern of DEFAULT_TOKEN_PATTERNS) {
    const result = replacePattern(clean, pattern, "");
    clean = result.text;
    strippedCount += result.count;
  }

  return {
    cleanText: safeSlice(normalizeWhitespace(clean), MAX_THOUGHT_CONTEXT_CHARS),
    strippedCount,
  };
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

  const thoughtContent = `[Thought Context: ${cleanText}]`;
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
