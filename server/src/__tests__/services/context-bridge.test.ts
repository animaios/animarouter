import type { ChatMessage } from "@animarouter/shared/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildContextBridge,
  createStreamingContextBridge,
  sanitizeForBridge,
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

describe("sanitizeForBridge (public testing API)", () => {
  it("exports the same sanitization as sanitizeForCrossProvider", () => {
    const resultBridge = sanitizeForBridge(
      "<|assistant|> Test response",
      "openai",
    );
    const resultCross = sanitizeForCrossProvider(
      "<|assistant|> Test response",
      "openai",
    );

    expect(resultBridge.cleanText).toBe(resultCross.cleanText);
    expect(resultBridge.strippedCount).toBe(resultCross.strippedCount);
  });

  it("strips provider-specific tokens for commandcode", () => {
    const result = sanitizeForBridge(
      "<|tool_calls_section_begin|>hidden<|tool_calls_section_end|> visible",
      "commandcode",
    );

    expect(result.cleanText).toContain("visible");
    // Section begin/end tokens are stripped by token patterns, but the text between them remains
    expect(result.cleanText).not.toContain("tool_calls_section_begin");
    expect(result.cleanText).not.toContain("tool_calls_section_end");
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("handles empty/null input gracefully", () => {
    expect(sanitizeForBridge("", "openai").cleanText).toBe("");
    expect(sanitizeForBridge(null as any, "openai").cleanText).toBe("");
    expect(sanitizeForBridge(undefined as any, "openai").cleanText).toBe("");
  });
});

describe("createStreamingContextBridge", () => {
  it("creates a bridge with foundation and injection providers", () => {
    const bridge = createStreamingContextBridge({
      foundationProvider: "commandcode",
      injectionProvider: "openai",
    });

    expect(typeof bridge.onFoundationComplete).toBe("function");
    expect(typeof bridge.onInjectionComplete).toBe("function");
    expect(typeof bridge.buildContextBridge).toBe("function");
  });

  describe("onFoundationComplete", () => {
    it("returns injection prompt with sanitized foundation text", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "commandcode",
        injectionProvider: "openai",
      });

      const foundationText =
        'Base logic <|tool_call_begin|>functions.lookup:0<|tool_call_argument_begin|>{"q":"x"}<|tool_call_end|> final.';
      const injectionPrompt = bridge.onFoundationComplete(foundationText);

      expect(injectionPrompt).toContain("[Thought Context:");
      expect(injectionPrompt).toContain("Base logic");
      expect(injectionPrompt).toContain("final.");
      expect(injectionPrompt).not.toContain("<|tool_call");
    });

    it("returns empty string when foundation text sanitizes to empty", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "commandcode",
        injectionProvider: "openai",
      });

      // Only tool calls, no actual content
      const foundationText =
        '<|tool_calls_section_begin|><|tool_call_begin|>functions.lookup:0<|tool_call_argument_begin|>{"q":"x"}<|tool_call_end|><|tool_calls_section_end|>';
      const injectionPrompt = bridge.onFoundationComplete(foundationText);

      expect(injectionPrompt).toBe("");
    });

    it("applies foundation provider sanitizer, not injection provider", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "google",
        injectionProvider: "openai",
      });

      // Google-specific tokens should be stripped by foundation provider
      const foundationText =
        "Gemini ran code: <code_execution_result>42</code_execution_result>";
      const injectionPrompt = bridge.onFoundationComplete(foundationText);

      expect(injectionPrompt).toContain("Gemini ran code:");
      expect(injectionPrompt).toContain("42");
      expect(injectionPrompt).not.toContain("code_execution_result");
    });
  });

  describe("onInjectionComplete", () => {
    it("returns anchor prompt with sanitized injection text", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "commandcode",
        injectionProvider: "openai",
      });

      const injectionText = "Thinking...\n<|assistant|> Injected answer";
      const anchorPrompt = bridge.onInjectionComplete(injectionText);

      expect(anchorPrompt).toContain("[Thought Context:");
      expect(anchorPrompt).toContain("Thinking...");
      expect(anchorPrompt).toContain("Injected answer");
      expect(anchorPrompt).not.toContain("<|assistant|>");
    });

    it("returns empty string when injection text sanitizes to empty", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "commandcode",
        injectionProvider: "openai",
      });

      const injectionText = "<|assistant|><|im_end|>";
      const anchorPrompt = bridge.onInjectionComplete(injectionText);

      expect(anchorPrompt).toBe("");
    });

    it("applies injection provider sanitizer", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "commandcode",
        injectionProvider: "google",
      });

      // Google-specific tokens should be stripped by injection provider
      const injectionText = "Ran <executable_code>code</executable_code> here";
      const anchorPrompt = bridge.onInjectionComplete(injectionText);

      expect(anchorPrompt).toContain("Ran");
      expect(anchorPrompt).toContain("code");
      expect(anchorPrompt).toContain("here");
      expect(anchorPrompt).not.toContain("executable_code");
    });
  });

  describe("buildContextBridge (non-streaming fallback)", () => {
    it("returns injection prompt for mode=injection using foundation provider", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "commandcode",
        injectionProvider: "openai",
      });

      const result = bridge.buildContextBridge(
        "Base <|tool_call_begin|>call<|tool_call_end|> end",
        "injection",
      );

      expect(result).toContain("[Thought Context:");
      expect(result).toContain("Base");
      expect(result).toContain("end");
      expect(result).not.toContain("<|tool_call");
    });

    it("returns anchor prompt for mode=anchor using injection provider", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "commandcode",
        injectionProvider: "openai",
      });

      const result = bridge.buildContextBridge(
        "Injected <|im_start|> content",
        "anchor",
      );

      expect(result).toContain("[Thought Context:");
      expect(result).toContain("Injected");
      expect(result).toContain("content");
      expect(result).not.toContain("<|im_start|>");
    });

    it("returns empty string when input sanitizes to empty", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "commandcode",
        injectionProvider: "openai",
      });

      expect(
        bridge.buildContextBridge(
          "<|tool_call_begin|>x<|tool_call_end|>",
          "injection",
        ),
      ).toBe("");
      expect(
        bridge.buildContextBridge("<|assistant|><|im_end|>", "anchor"),
      ).toBe("");
    });
  });

  describe("streaming flow integration", () => {
    it("simulates complete streaming oscillator flow", () => {
      const bridge = createStreamingContextBridge({
        foundationProvider: "commandcode",
        injectionProvider: "openai",
      });

      // Step 1: Foundation completes, produces injection prompt
      const foundationFullText =
        'Foundation analysis <|tool_call_begin|>functions.search:0<|tool_call_argument_begin|>{"q":"test"}<|tool_call_end|> conclusion.';
      const injectionPrompt = bridge.onFoundationComplete(foundationFullText);

      expect(injectionPrompt).toContain("[Thought Context:");
      expect(injectionPrompt).toContain("Foundation analysis");
      expect(injectionPrompt).toContain("conclusion.");
      expect(injectionPrompt).not.toContain("tool_call");

      // Step 2: Injection completes, produces anchor prompt
      const injectionFullText = "Injection step done <|im_end|> final";
      const anchorPrompt = bridge.onInjectionComplete(injectionFullText);

      expect(anchorPrompt).toContain("[Thought Context:");
      expect(anchorPrompt).toContain("Injection step done");
      expect(anchorPrompt).toContain("final");
      expect(anchorPrompt).not.toContain("<|im_end|>");

      // Both prompts should have the expected format
      expect(injectionPrompt.startsWith("[Thought Context: ")).toBe(true);
      expect(anchorPrompt.startsWith("[Thought Context: ")).toBe(true);
    });
  });
});
