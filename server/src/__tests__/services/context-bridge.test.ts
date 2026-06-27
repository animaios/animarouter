import type { ChatMessage } from "@animarouter/shared/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildContextBridge,
  sanitizeForCrossProvider,
} from "../../services/context-bridge.js";
import {
  _clearStoreForTesting,
  recordIncomingMessages,
  recordSuccessfulModel,
} from "../../services/context-handoff.js";

const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({
  role,
  content,
});

describe("sanitizeForCrossProvider", () => {
  it("strips OpenAI-style special tokens and generic role markers", () => {
    const result = sanitizeForCrossProvider(
      "<|im_start|>assistant\nBase answer.<|im_end|>\n<|assistant|>",
      "openai",
    );

    expect(result.cleanText).toBe("assistant\nBase answer.");
    expect(result.cleanText).not.toContain("<|");
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("strips token-dialect tool blocks while preserving surrounding prose", () => {
    const result = sanitizeForCrossProvider(
      [
        "Before.",
        "<|tool_calls_section_begin|>",
        "<|tool_call_begin|>functions.lookup:0",
        '<|tool_call_argument_begin|>{"q":"x"}<|tool_call_end|>',
        "<|tool_calls_section_end|>",
        "After.",
      ].join("\n"),
      "commandcode",
    );

    expect(result.cleanText).toContain("Before.");
    expect(result.cleanText).toContain("After.");
    expect(result.cleanText).not.toContain("tool_call");
    expect(result.cleanText).not.toContain("functions.lookup");
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("removes provider structural markers without dropping useful text", () => {
    const result = sanitizeForCrossProvider(
      "Gemini ran code: <code_execution_result>42</code_execution_result>",
      "google",
    );

    expect(result.cleanText).toBe("Gemini ran code: 42");
    expect(result.cleanText).not.toContain("code_execution_result");
  });

  it("falls back to generic sanitizer for unknown providers", () => {
    const result = sanitizeForCrossProvider(
      "[INST] Please ignore [/INST] <system>hidden marker</system> Useful answer.",
      "custom-provider",
    );

    expect(result.cleanText).toBe("Please ignore hidden marker Useful answer.");
    expect(result.cleanText).not.toContain("[INST]");
    expect(result.cleanText).not.toContain("<system>");
  });

  it("handles null provider names and still applies default cleanup", () => {
    const result = sanitizeForCrossProvider(
      "<|assistant|> Useful answer.",
      null,
    );

    expect(result.cleanText).toBe("[Assistant Context] Useful answer.");
    expect(result.cleanText).not.toContain("<|assistant|>");
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("keeps truncated thought context within the configured character cap", () => {
    const result = sanitizeForCrossProvider("x".repeat(7000), "openai");

    expect(result.cleanText.length).toBeLessThanOrEqual(6000);
    expect(result.cleanText.endsWith("\n...[truncated]")).toBe(true);
  });
});

describe("buildContextBridge", () => {
  beforeEach(() => {
    _clearStoreForTesting();
  });

  it("preserves standard context handoff behavior", () => {
    const messages = [msg("user", "continue this task")];
    recordIncomingMessages("sess-standard", [
      msg("user", "first ask"),
      msg("assistant", "first answer"),
    ]);
    recordSuccessfulModel({
      sessionKey: "sess-standard",
      modelKey: "groq:llama",
    });

    const result = buildContextBridge({
      mode: "on_model_switch",
      sessionKey: "sess-standard",
      messages,
      selectedModelKey: "google:gemini",
      sourceProvider: "groq",
    });

    expect(result.bridgeType).toBe("standard_handoff");
    expect(
      result.messages.some((m) =>
        String(m.content).includes("AnimaRouter context handoff:"),
      ),
    ).toBe(true);
    expect(
      result.messages.some((m) =>
        String(m.content).startsWith("[Thought Context:"),
      ),
    ).toBe(false);
  });

  it("injects sanitized thought context for oscillator handoff", () => {
    const messages = [
      msg("system", "existing system"),
      msg("user", "solve it"),
    ];

    const result = buildContextBridge({
      mode: "off",
      sessionKey: "sess-osc",
      messages,
      selectedModelKey: "google:gemini",
      sourceProvider: "commandcode",
      isOscillatorHandoff: true,
      priorResponseText:
        'Base logic <|tool_call_begin|>functions.lookup:0<|tool_call_argument_begin|>{"q":"x"}<|tool_call_end|> final.',
    });

    expect(result.bridgeType).toBe("oscillator_handoff");
    expect(result.strippedArtifacts).toBeGreaterThan(0);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(
      String(result.messages[1].content).startsWith("[Thought Context:"),
    ).toBe(true);
    expect(String(result.messages[1].content)).toContain("Base logic");
    expect(String(result.messages[1].content)).toContain("final.");
    expect(String(result.messages[1].content)).not.toContain("<|tool_call");
    expect(result.messages[2]).toEqual(messages[1]);
  });

  it("does not duplicate an existing thought context message", () => {
    const messages = [
      msg("system", "[Thought Context: already present]"),
      msg("user", "solve it"),
    ];

    const result = buildContextBridge({
      mode: "off",
      sessionKey: "sess-dup",
      messages,
      selectedModelKey: "google:gemini",
      sourceProvider: "openai",
      isOscillatorHandoff: true,
      priorResponseText: "<|im_start|>assistant new context <|im_end|>",
    });

    expect(result.bridgeType).toBe("none");
    expect(result.messages).toBe(messages);
    expect(
      result.messages.filter((m) =>
        String(m.content).startsWith("[Thought Context:"),
      ),
    ).toHaveLength(1);
  });
});
